/**
 * Qdrant 搜索客户端（供 API 路由使用）
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const COLLECTION = 'resources_v2'
const SPARSE_VECTOR_NAME = 'bm25'
const MEMORY_COLLECTION = 'conversation_memory'

/** 生成带 API Key 认证的请求头 */
function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.QDRANT_API_KEY) h['api-key'] = process.env.QDRANT_API_KEY
  return h
}


export interface QdrantCondition {
  key: string
  match: { value: string }
}

export interface QdrantFilter {
  must?: QdrantCondition[]
  should?: QdrantCondition[]
}

export interface QdrantSearchResult {
  content: string
  metadata: Record<string, any>
  score: number
}

let pointCounter = Date.now()

export async function upsertPoint(
  vector: number[],
  payload: Record<string, any>,
  sparseVectors?: Record<string, { indices: number[]; values: number[] }>,
): Promise<void> {
  const id = ++pointCounter
  const point: any = { id, vector, payload }
  if (sparseVectors) point.sparse_vectors = sparseVectors
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      points: [point],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`Qdrant upsert failed: ${res.status} ${text}`)
  }
}

export async function searchSimilar(
  vector: number[],
  limit = 3,
  filter?: QdrantFilter,
): Promise<QdrantSearchResult[]> {
  const url = `${QDRANT_URL}/collections/${COLLECTION}/points/search`
  const body: Record<string, any> = { vector, limit, with_payload: true }
  if (filter) body.filter = filter

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant search failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  return data.result.map((r: any) => ({
    content: r.payload.content || '',
    metadata: {
      type: r.payload.type || '',
      source: r.payload.source || '',
      gameName: r.payload.gameName || '',
      charName: r.payload.charName || '',
      filter: filter ? JSON.stringify(filter) : '',
    },
    score: r.score,
  }))
}

export interface SparseInput {
  indices: number[]
  values: number[]
}

/** searchSparse — 稀疏向量搜索 */
export async function searchSparse(
  sparse: SparseInput,
  limit = 10,
  filter?: QdrantFilter,
): Promise<QdrantSearchResult[]> {
  const body: Record<string, any> = {
    vector: { name: SPARSE_VECTOR_NAME, vector: sparse },
    limit,
    with_payload: true,
  }
  if (filter) body.filter = filter

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant sparse search failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  return data.result.map((r: any) => ({
    content: r.payload.content || '',
    metadata: {
      type: r.payload.type || '',
      source: r.payload.source || '',
      gameName: r.payload.gameName || '',
      charName: r.payload.charName || '',
      filter: filter ? JSON.stringify(filter) : '',
    },
    score: r.score,
  }))
}

// ── Conversation Memory collection ─────────────────────

/** 确保 conversation_memory collection 存在（幂等） */
export async function ensureConversationMemoryCollection(): Promise<void> {
  const exists = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}`, {
    method: 'GET',
    headers: headers(),
  })
    .then(r => r.ok)
    .catch(() => false)

  if (!exists) {
    const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        name: MEMORY_COLLECTION,
        vectors: { size: 1024, distance: 'Cosine' },
        sparse_vectors: { [SPARSE_VECTOR_NAME]: {} },
        optimizers_config: { default_segment_number: 8 },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`Qdrant create memory collection failed: ${res.status} ${text}`)
    }
  }
}

/** 写入一条对话记忆（支持 sparse vectors） */
export async function upsertMemoryPoint(
  vector: number[],
  payload: Record<string, any>,
  sparseVectors?: Record<string, { indices: number[]; values: number[] }>,
): Promise<void> {
  const id = ++pointCounter
  const point: any = { id, vector, payload }
  if (sparseVectors) point.sparse_vectors = sparseVectors
  const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ points: [point] }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`Qdrant memory upsert failed: ${res.status} ${text}`)
  }
}

/** 对话记忆混合搜索：dense + sparse 各自搜后用 RRF 合并 */
export async function searchConversationMemoryHybrid(
  denseVector: number[],
  sparseVector: { indices: number[]; values: number[] },
  limit = 3,
  conversationId?: string,
): Promise<QdrantSearchResult[]> {
  const denseLimit = limit * 4
  const sparseLimit = limit * 4
  const k = 60 // RRF 常数
  const MIN_SCORE = 0.15 // RRF 分数阈值

  // 有 conversationId 时只搜当前对话
  const filter = conversationId
    ? { must: [{ key: 'conversationId', match: { value: conversationId } }] }
    : undefined

  const searchBody: Record<string, any> = { vector: denseVector, limit: denseLimit, with_payload: true }
  if (filter) searchBody.filter = filter

  const sparseSearchBody: Record<string, any> = {
    vector: { name: SPARSE_VECTOR_NAME, vector: sparseVector },
    limit: sparseLimit,
    with_payload: true,
  }
  if (filter) sparseSearchBody.filter = filter

  const [denseRes, sparseRes] = await Promise.all([
    fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(searchBody),
    }),
    fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(sparseSearchBody),
    }),
  ])

  if (!denseRes.ok) throw new Error(`dense search failed: ${denseRes.status}`)
  if (!sparseRes.ok) throw new Error(`sparse search failed: ${sparseRes.status}`)

  const denseData = (await denseRes.json()).result || []
  const sparseData = (await sparseRes.json()).result || []

  // RRF 合并
  const rrfScores = new Map<string, { score: number; payload: any }>()
  for (const [rank, r] of denseData.entries()) {
    const id = String(r.id)
    rrfScores.set(id, {
      score: 1 / (k + rank + 1),
      payload: r.payload,
    })
  }
  for (const [rank, r] of sparseData.entries()) {
    const id = String(r.id)
    const existing = rrfScores.get(id)
    const addScore = 1 / (k + rank + 1)
    if (existing) {
      existing.score += addScore
    } else {
      rrfScores.set(id, { score: addScore, payload: r.payload })
    }
  }

  return Array.from(rrfScores.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .filter(([, entry]) => entry.score >= MIN_SCORE)
    .map(([id, entry]) => ({
      content: entry.payload.userMessage
        ? `用户: ${entry.payload.userMessage}\nAI: ${entry.payload.assistantMessage || ''}`
        : entry.payload.summary || '',
      metadata: {
        conversationId: entry.payload.conversationId || '',
        qaId: entry.payload.qaId || '',
        userMessage: entry.payload.userMessage || '',
        assistantMessage: entry.payload.assistantMessage || '',
        createdAt: entry.payload.createdAt || 0,
      },
      score: entry.score,
    }))
}

/** 按 conversationId 删除对话记忆 */
export async function deleteConversationMemory(conversationId: string): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points/delete`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filter: { must: [{ key: 'conversationId', match: { value: conversationId } }] },
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`Qdrant delete memory failed: ${res.status} ${text}`)
  }
}

/** scroll 某对话的所有记忆 point（用于恢复对话原文） */
export async function scrollConversationMemory(
  conversationId: string,
): Promise<{ userMessage: string; assistantMessage: string; createdAt: number }[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filter: { must: [{ key: 'conversationId', match: { value: conversationId } }] },
      limit: 1000,
      with_payload: true,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`Qdrant scroll memory failed: ${res.status} ${text}`)
    return []
  }
  const data = await res.json()
  return (data.result?.points || [])
    .map((p: any) => ({
      userMessage: p.payload.userMessage || '',
      assistantMessage: p.payload.assistantMessage || '',
      createdAt: p.payload.createdAt || 0,
    }))
    .sort((a: any, b: any) => a.createdAt - b.createdAt)
}

// ── 批量写入 & 查询（供 backfill 使用） ────────────────

/** 确保 resources_v2 collection 存在 */
export async function ensureResourceCollection(): Promise<void> {
  const exists = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: 'GET',
    headers: headers(),
  })
    .then(r => r.ok)
    .catch(() => false)

  if (!exists) {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        name: COLLECTION,
        vectors: { size: 1024, distance: 'Cosine' },
        sparse_vectors: { [SPARSE_VECTOR_NAME]: {} },
        optimizers_config: { default_segment_number: 8 },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Qdrant create collection failed: ${res.status} ${text}`)
    }
  }
}

export interface QdrantBatchPoint {
  id: number
  vector: number[]
  payload: Record<string, any>
  sparse_vectors?: Record<string, { indices: number[]; values: number[] }>
}

/** 批量写入 resources_v2 */
export async function upsertBatch(points: QdrantBatchPoint[]): Promise<void> {
  if (points.length === 0) return
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ points }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant upsertBatch failed: ${res.status} ${text}`)
  }
}

/** 按 filter 滚动查询（用于去重检查） */
export async function scrollByFilter(
  filter: Record<string, any>,
  limit = 10,
): Promise<{ id: number; payload: Record<string, any> }[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ filter, limit, with_payload: true }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant scroll failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  return (data.result?.points || []).map((p: any) => ({
    id: p.id,
    payload: p.payload,
  }))
}

let _pointIdSeq = Date.now()

/** 生成单调递增的数字 ID */
export function nextPointId(): number {
  return ++_pointIdSeq
}
