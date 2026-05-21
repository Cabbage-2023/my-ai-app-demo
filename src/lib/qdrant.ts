/**
 * Qdrant 搜索客户端（供 API 路由使用）
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const COLLECTION = 'resources_v2'
const SPARSE_VECTOR_NAME = 'bm25'
const MEMORY_COLLECTION = 'conversation_memory'


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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
  const exists = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}`, { method: 'GET' })
    .then(r => r.ok)
    .catch(() => false)

  if (!exists) {
    const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
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

/** 写入一条对话记忆 */
export async function upsertMemoryPoint(
  vector: number[],
  payload: Record<string, any>,
): Promise<void> {
  const id = ++pointCounter
  const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [{ id, vector, payload }] }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`Qdrant memory upsert failed: ${res.status} ${text}`)
  }
}

/** 搜索对话记忆 */
export async function searchConversationMemory(
  vector: number[],
  limit = 3,
): Promise<QdrantSearchResult[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, limit, with_payload: true }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant memory search failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  return data.result.map((r: any) => ({
    content: r.payload.summary || '',
    metadata: {
      conversationId: r.payload.conversationId || '',
      tags: r.payload.tags || [],
      keyFacts: r.payload.keyFacts || [],
      messageCount: r.payload.messageCount || 0,
      createdAt: r.payload.createdAt || 0,
    },
    score: r.score,
  }))
}

// ── 批量写入 & 查询（供 backfill 使用） ────────────────

/** 确保 resources_v2 collection 存在 */
export async function ensureResourceCollection(): Promise<void> {
  const exists = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { method: 'GET' })
    .then(r => r.ok)
    .catch(() => false)

  if (!exists) {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
