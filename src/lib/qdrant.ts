/**
 * Qdrant 搜索客户端（供 API 路由使用）
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const COLLECTION = 'resources'

export interface QdrantSearchResult {
  content: string
  metadata: Record<string, any>
  score: number
}

let pointCounter = Date.now()

export async function upsertPoint(
  vector: number[],
  payload: Record<string, any>,
): Promise<void> {
  const id = ++pointCounter
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [{ id, vector, payload }],
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
): Promise<QdrantSearchResult[]> {
  const url = `${QDRANT_URL}/collections/${COLLECTION}/points/search`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
    }),
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
    },
    score: r.score,
  }))
}
