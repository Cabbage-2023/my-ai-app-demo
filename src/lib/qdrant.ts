/**
 * Qdrant 搜索客户端（供 API 路由使用）
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const COLLECTION = 'resources_v2'
const SPARSE_VECTOR_NAME = 'bm25'


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
