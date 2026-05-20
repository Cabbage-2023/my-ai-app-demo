/**
 * 将 resources 数据迁移到 resources_v2，并在迁移时补充 sparse vector
 *
 * 用法：
 *   npx tsx scripts/etl/migrate-with-sparse.ts
 */
import 'dotenv/config'
import { generateSparseEmbedding } from '../../src/lib/ai/sparse-embedding'

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const OLD_COLLECTION = 'resources'
const NEW_COLLECTION = 'resources_v2'
const SPARSE_VECTOR_NAME = 'bm25'
const BATCH_SIZE = 100

interface ScrollPoint {
  id: number
  vector?: number[]
  payload: Record<string, any>
}

async function scrollPoints(offset?: number): Promise<{ points: ScrollPoint[]; nextOffset?: number }> {
  const res = await fetch(`${QDRANT_URL}/collections/${OLD_COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: BATCH_SIZE, with_payload: true, with_vector: true, offset }),
  })
  if (!res.ok) throw new Error(`scroll failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return { points: data.result.points, nextOffset: data.result.next_page_offset }
}

async function ensureNewCollection(): Promise<void> {
  const exists = await fetch(`${QDRANT_URL}/collections/${NEW_COLLECTION}`).then(r => r.ok).catch(() => false)
  if (exists) return

  const res = await fetch(`${QDRANT_URL}/collections/${NEW_COLLECTION}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: NEW_COLLECTION,
      vectors: { size: 1024, distance: 'Cosine' },
      sparse_vectors: { [SPARSE_VECTOR_NAME]: {} },
      optimizers_config: { default_segment_number: 8 },
    }),
  })
  if (!res.ok) throw new Error(`create collection failed: ${res.status} ${await res.text()}`)
  console.log(`  集合 ${NEW_COLLECTION} 已创建（含 sparse_vectors）`)
}

async function main() {
  console.log('=== 迁移数据 + 补充 sparse vector ===\n')

  await ensureNewCollection()

  let total = 0
  let offset: number | undefined
  let errors = 0

  do {
    const { points, nextOffset } = await scrollPoints(offset)
    if (points.length === 0) break

    const batch = points.map(p => {
      const content = p.payload?.content || ''
      const sparse = content ? generateSparseEmbedding(content) : { indices: [], values: [] }
      return {
        id: p.id,
        vector: p.vector,
        payload: p.payload,
        sparse_vectors: { [SPARSE_VECTOR_NAME]: sparse },
      }
    })

    try {
      const res = await fetch(`${QDRANT_URL}/collections/${NEW_COLLECTION}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: batch, wait: false }),
      })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    } catch (e) {
      console.error(`  batch ${total} 失败: ${(e as Error).message}`)
      errors++
    }

    total += points.length
    if (total % 1000 === 0 || nextOffset == null) {
      console.log(`  进度: ${total} 条已迁移`)
    }

    offset = nextOffset
  } while (offset != null)

  console.log(`\n完成: 迁移 ${total} 条到 ${NEW_COLLECTION}${errors ? `, ${errors} 个 batch 失败` : ''}`)
  console.log(`\n下一步：将 qdrant.ts 中的 COLLECTION 改为 '${NEW_COLLECTION}'`)
}

main().catch(console.error)
