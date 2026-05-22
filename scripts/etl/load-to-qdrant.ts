/**
 * 从本地 embedding 缓存 → 灌入服务器 Qdrant + MongoDB
 *
 * 用法：
 *   npx tsx scripts/load-to-qdrant.ts
 *
 * 流程：
 *   1. 读取 scripts/data/cache/embedded-chunks.jsonl（JSONL 格式）
 *   2. 分批写入 Qdrant（每批 100 条）
 *   3. 分批写入 MongoDB（每批 500 条）
 */
import 'dotenv/config'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { MongoClient } from 'mongodb'
import { upsertBatch, ensureResourceCollection } from '../../src/lib/qdrant'
import { GAME_ALIASES, PRODUCER_GAMES, CHAR_ALIASES } from '../lib/name-aliases'
import { generateSparseEmbedding } from '../../src/lib/ai/sparse-embedding'

/** Qdrant count API */
async function countQdrantPoints(): Promise<number> {
  const url = `${process.env.QDRANT_URL || 'http://localhost:3933'}/collections/resources_v2/points/count`
  const res = await fetch(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) return 0
  const data = await res.json()
  return data.result?.count ?? 0
}

const CACHE_PATH = path.resolve('scripts/data/cache/embedded-chunks.jsonl')
const QDRANT_BATCH = 100
const MONGO_BATCH = 500

/**
 * 计算 gameName/charName 对应的别名字段
 *
 * 三层来源：
 *   1. 人工维护的 GAME_ALIASES / PRODUCER_GAMES / CHAR_ALIASES
 *   2. 自动规则：剥离 " - " / "～" 后的主标题作为短名
 *   3. PRODUCER_GAMES 中的品牌名同时放入 gameAliases 和 producer
 */
function computeNameAliases(gameName: string, charName: string): Record<string, any> {
  const updates: Record<string, any> = {}
  const aliasSet = new Set<string>()

  // 1. 已知别名映射
  for (const [alias, fullNames] of Object.entries(GAME_ALIASES)) {
    if (fullNames.includes(gameName)) aliasSet.add(alias)
  }

  // 2. 自动规则：取 " - " / "～" 前的部分做短名
  const sepMatch = gameName.match(/^(.+?)\s*[～~\-—]\s*/)
  if (sepMatch) {
    const short = sepMatch[1].trim()
    if (short && short !== gameName) aliasSet.add(short)
  }

  // 3. 制作商/品牌 → 同时放入 gameAliases 和 producer
  for (const [brand, games] of Object.entries(PRODUCER_GAMES)) {
    if (games.includes(gameName)) {
      aliasSet.add(brand)
      updates.producer = brand
    }
  }

  if (aliasSet.size > 0) {
    updates.gameAliases = [...aliasSet]
  }

  // 4. 角色别名（收集所有匹配的别名，兼保留 charNameCN 向后兼容）
  const charAliasSet = new Set<string>()
  for (const [cnName, jpNames] of Object.entries(CHAR_ALIASES)) {
    if (jpNames.includes(charName)) {
      charAliasSet.add(cnName)
    }
  }
  if (charAliasSet.size > 0) {
    updates.charNameCN = [...charAliasSet][0]
    updates.charAliases = [...charAliasSet]
  }

  return updates
}

async function main() {
  console.log('=== 缓存 → 服务器 Qdrant + MongoDB ===\n')

  // 1. 读缓存（JSONL 格式，逐行解析）
  const cached: any[] = []
  const rl = createInterface({ input: createReadStream(CACHE_PATH, 'utf-8'), crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { cached.push(JSON.parse(trimmed)) } catch { /* skip malformed */ }
  }
  console.log(`读取缓存: ${cached.length} 条带向量数据\n`)

  // 2. 确保 Qdrant 集合存在
  console.log('检查 Qdrant 集合...')
  await ensureResourceCollection()

  // 3. 写入 Qdrant
  console.log('\n写入 Qdrant...')
  let qdrantInserted = 0
  for (let i = 0; i < cached.length; i += QDRANT_BATCH) {
    const batch = cached.slice(i, i + QDRANT_BATCH)
    const points = batch.map((c: any, idx: number) => {
      const gameName = c.metadata.gameName || ''
      const charName = c.metadata.charName || ''
      const aliases = computeNameAliases(gameName, charName)
      const sparse = generateSparseEmbedding(c.content)
      return {
        id: i + idx + 1,
        vector: c.embedding,
        sparse_vectors: { bm25: sparse },
        payload: {
          content: c.content,
          dedupKey: c.dedupKey,
          type: c.metadata.type,
          source: c.metadata.source,
          gameName,
          charName,
          chunkIndex: c.metadata.chunkIndex ?? -1,
          totalChunks: c.metadata.totalChunks ?? -1,
          ...aliases,
        },
      }
    })
    await upsertBatch(points)
    qdrantInserted += batch.length
    console.log(`  Qdrant 进度: ${Math.min(i + QDRANT_BATCH, cached.length)}/${cached.length}`)
  }
  const qdrantCount = await countQdrantPoints()
  console.log(`Qdrant 写入完成: ${qdrantInserted} 条，集合共 ${qdrantCount} 条`)

  // 4. 写入 MongoDB
  const mongoUri = process.env.MONGODB_URI_LOCAL
  if (!mongoUri) {
    console.log('\nMONGODB_URI_LOCAL 未设置，跳过 MongoDB 写入。')
    return
  }

  console.log('\n写入 MongoDB (server)...')
  const client = new MongoClient(mongoUri)
  try {
    await client.connect()
    const db = client.db()
    const col = db.collection('resources')

    // 查重
    const docCount = await col.countDocuments()
    let toInsert: any[]
    if (docCount === 0) {
      toInsert = cached
      console.log(`  集合为空，全部 ${toInsert.length} 条为新数据`)
    } else {
      const keys = cached.map((c: any) => c.dedupKey)
      const existingKeys = new Set<string>()
      for (let i = 0; i < keys.length; i += 2000) {
        const batchKeys = keys.slice(i, i + 2000)
        const docs = await col.find(
          { dedupKey: { $in: batchKeys } },
          { projection: { dedupKey: 1 } },
        ).toArray()
        for (const d of docs) existingKeys.add((d as any).dedupKey)
      }
      toInsert = cached.filter((c: any) => !existingKeys.has(c.dedupKey))
      console.log(`  已有 ${existingKeys.size} 条重复，新增 ${toInsert.length} 条`)
    }

    if (toInsert.length === 0) {
      console.log('  无新增数据，跳过。')
    } else {
      let inserted = 0
      for (let i = 0; i < toInsert.length; i += MONGO_BATCH) {
        const batch = toInsert.slice(i, i + MONGO_BATCH)
        const docs = batch.map((c: any) => ({
          content: c.content,
          embedding: c.embedding,
          metadata: c.metadata,
          dedupKey: c.dedupKey,
        }))
        const r = await col.insertMany(docs, { ordered: false })
        inserted += r.insertedCount
        console.log(`  MongoDB 进度: ${Math.min(i + MONGO_BATCH, toInsert.length)}/${toInsert.length}`)
      }
      console.log(`MongoDB 写入完成: ${inserted} 条`)
    }
  } finally {
    await client.close()
  }

  console.log('\n=== 全部完成 ===')
}

main().catch(console.error)
