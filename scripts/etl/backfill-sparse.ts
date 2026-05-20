/**
 * 为存量数据补充 sparse vector
 *
 * 遍历 Qdrant 中所有 point，读取 content + 现有 dense vector → 生成稀疏向量 → 全量回写
 *
 * 用法：
 *   npx tsx scripts/etl/backfill-sparse.ts
 *   # 可指定最大处理数做测试：
 *   npx tsx scripts/etl/backfill-sparse.ts --limit=100
 */
import 'dotenv/config'
import { generateSparseEmbedding } from '../../src/lib/ai/sparse-embedding'

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:3933'
const COLLECTION = 'resources'
const SPARSE_VECTOR_NAME = 'bm25'
const BATCH_SIZE = 100

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const MAX_POINTS = limitArg ? parseInt(limitArg.replace('--limit=', ''), 10) : Infinity

interface ScrollPoint {
  id: number
  vector?: number[]
  payload: Record<string, any>
}

async function scrollPoints(offset?: number): Promise<{ points: ScrollPoint[]; nextOffset?: number }> {
  const body: any = { limit: BATCH_SIZE, with_payload: true, with_vector: true }
  if (offset != null) body.offset = offset

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Qdrant scroll failed: ${res.status} ${text}`)
  }

  const data = await res.json()
  return { points: data.result.points, nextOffset: data.result.next_page_offset }
}

async function updatePoints(points: ScrollPoint[]): Promise<void> {
  const batch = points.map(p => {
    const content = p.payload?.content || ''
    const sparse = generateSparseEmbedding(content)
    return {
      id: p.id,
      vector: p.vector,
      payload: p.payload,
      sparse_vectors: { [SPARSE_VECTOR_NAME]: sparse },
    }
  })

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: batch, wait: false }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`  回写失败: ${res.status} ${text}`)
  }
}

async function main() {
  console.log('=== 为存量数据补 sparse vector ===\n')

  let total = 0
  let errors = 0
  let offset: number | undefined

  do {
    const { points, nextOffset } = await scrollPoints(offset)
    if (points.length === 0) break

    try {
      await updatePoints(points)
    } catch (e) {
      console.error(`  batch 失败: ${(e as Error).message}`)
      errors++
    }

    total += points.length
    if (total % 500 === 0 || nextOffset == null) {
      console.log(`  进度: ${total} 条已处理${MAX_POINTS !== Infinity ? ` (上限 ${MAX_POINTS})` : ''}`)
    }

    offset = nextOffset
    if (total >= MAX_POINTS) {
      console.log(`  已达处理上限 ${MAX_POINTS}，停止`)
      break
    }
  } while (offset != null)

  console.log(`\n完成: 处理 ${total} 条${errors ? `, ${errors} 个 batch 失败` : ''}`)
}

main().catch(console.error)
