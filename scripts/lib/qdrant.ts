/**
 * Qdrant 客户端封装
 *
 * 用法：
 *   import { qdrant } from './lib/qdrant'
 *   await qdrant.ensureCollection()
 *   await qdrant.upsert(id, vector, payload)
 *   const results = await qdrant.search(vector, { limit: 5, filter: {...} })
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const COLLECTION = 'resources_v2'
const VECTOR_SIZE = 1024
const SPARSE_VECTOR_NAME = 'bm25'

export interface QdrantPoint {
  id: number
  vector: number[]
  payload: Record<string, any>
  sparse_vectors?: Record<string, { indices: number[]; values: number[] }>
}

export interface QdrantSearchResult {
  id: number
  score: number
  payload: Record<string, any>
}

async function request<T>(method: string, path: string, body?: any): Promise<T> {
  const url = `${QDRANT_URL}${path}`
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant ${method} ${path}: ${res.status} ${text}`)
  }
  return res.json()
}

// ensureCollection — 确保集合存在且配置正确（幂等）
export async function ensureCollection(): Promise<void> {
  const exists = await request<any>('GET', `/collections/${COLLECTION}`).catch(() => null)

  if (!exists) {
    await request('PUT', `/collections/${COLLECTION}`, {
      name: COLLECTION,
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      sparse_vectors: { [SPARSE_VECTOR_NAME]: {} },
      optimizers_config: { default_segment_number: 8 },
    })
    console.log(`  集合 ${COLLECTION} 已创建（含 sparse_vectors）`)
    return
  }

  // 已有集合但缺少 sparse_vectors → 补充配置
  if (!exists.result?.config?.params?.sparse_vectors?.[SPARSE_VECTOR_NAME]) {
    await request('PATCH', `/collections/${COLLECTION}`, {
      sparse_vectors_config: { [SPARSE_VECTOR_NAME]: {} },
    })
    console.log(`  集合 ${COLLECTION} 已补充 sparse_vectors 配置`)
  }
}

// upsert — 写入单条向量（可选附带 sparse_vectors）
export async function upsert(
  id: number,
  vector: number[],
  payload: Record<string, any>,
  sparseVectors?: Record<string, { indices: number[]; values: number[] }>,
): Promise<void> {
  const point: any = { id, vector, payload }
  if (sparseVectors) point.sparse_vectors = sparseVectors
  await request('PUT', `/collections/${COLLECTION}/points`, {
    points: [point],
  })
}

// upsertBatch — 批量写入（推荐，每批 ≤ 500 条）
export async function upsertBatch(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return
  await request('PUT', `/collections/${COLLECTION}/points`, {
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
      ...(p.sparse_vectors ? { sparse_vectors: p.sparse_vectors } : {}),
    })),
  })
}

// upsertWithOrdered — 批量写入（允许部分失败不影响其他）
export async function upsertBatchOrdered(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return
  await request('PUT', `/collections/${COLLECTION}/points`, {
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
      ...(p.sparse_vectors ? { sparse_vectors: p.sparse_vectors } : {}),
    })),
    wait: true,
    ordering: 'weak',
  })
}

// search — 向量搜索
export async function search(
  vector: number[],
  opts: { limit?: number; filter?: Record<string, any> } = {},
): Promise<QdrantSearchResult[]> {
  const { limit = 5, filter } = opts
  const result = await request<any>('POST', `/collections/${COLLECTION}/points/search`, {
    vector,
    limit,
    with_payload: true,
    filter,
  })
  return result.result.map((r: any) => ({
    id: r.id,
    score: r.score,
    payload: r.payload,
  }))
}

// count — 统计集合中的向量数
export async function count(): Promise<number> {
  const result = await request<any>('POST', `/collections/${COLLECTION}/points/count`, {})
  return result.result.count
}

// deletePoints — 按 filter 删除
export async function deletePoints(
  filter: Record<string, any>,
): Promise<void> {
  await request('POST', `/collections/${COLLECTION}/points/delete`, { filter })
}

// searchSparse — 稀疏向量搜索
export async function searchSparse(
  sparse: { indices: number[]; values: number[] },
  opts: { limit?: number; filter?: Record<string, any> } = {},
): Promise<QdrantSearchResult[]> {
  const { limit = 5, filter } = opts
  const result = await request<any>('POST', `/collections/${COLLECTION}/points/search`, {
    vector: { name: SPARSE_VECTOR_NAME, vector: sparse },
    limit,
    with_payload: true,
    filter,
  })
  return result.result.map((r: any) => ({
    id: r.id,
    score: r.score,
    payload: r.payload,
  }))
}
