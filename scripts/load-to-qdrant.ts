/**
 * 从本地 embedding 缓存 → 灌入服务器 Qdrant + MongoDB
 *
 * 用法：
 *   npx tsx scripts/load-to-qdrant.ts
 *
 * 流程：
 *   1. 读取 scripts/data/cache/embedded-chunks.json
 *   2. 分批写入 Qdrant（每批 100 条）
 *   3. 分批写入 MongoDB（每批 500 条）
 */
import 'dotenv/config'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { MongoClient } from 'mongodb'
import { upsertBatch, ensureCollection, count } from './lib/qdrant'

const CACHE_PATH = path.resolve('scripts/data/cache/embedded-chunks.json')
const QDRANT_BATCH = 100
const MONGO_BATCH = 500

async function main() {
  console.log('=== 缓存 → 服务器 Qdrant + MongoDB ===\n')

  // 1. 读缓存
  const cached = JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
  console.log(`读取缓存: ${cached.length} 条带向量数据\n`)

  // 2. 确保 Qdrant 集合存在
  console.log('检查 Qdrant 集合...')
  await ensureCollection()

  // 3. 写入 Qdrant
  console.log('\n写入 Qdrant...')
  let qdrantInserted = 0
  for (let i = 0; i < cached.length; i += QDRANT_BATCH) {
    const batch = cached.slice(i, i + QDRANT_BATCH)
    const points = batch.map((c: any, idx: number) => ({
      id: i + idx + 1,
      vector: c.embedding,
      payload: {
        content: c.content,
        dedupKey: c.dedupKey,
        type: c.metadata.type,
        source: c.metadata.source,
        gameName: c.metadata.gameName || '',
        charName: c.metadata.charName || '',
        chunkIndex: c.metadata.chunkIndex ?? -1,
        totalChunks: c.metadata.totalChunks ?? -1,
      },
    }))
    await upsertBatch(points)
    qdrantInserted += batch.length
    console.log(`  Qdrant 进度: ${Math.min(i + QDRANT_BATCH, cached.length)}/${cached.length}`)
  }
  const qdrantCount = await count()
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
