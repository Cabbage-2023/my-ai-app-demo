/**
 * 独立写入脚本：读取本地 embedding 缓存 → 分批写入 MongoDB
 *
 * 用法（先去代理）：
 *   unset HTTP_PROXY HTTPS_PROXY
 *   npx tsx scripts/load-cache-to-db.ts
 */
import 'dotenv/config'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { MongoClient } from 'mongodb'

const CACHE_PATH = path.resolve('scripts/data/cache/embedded-chunks.json')
const INSERT_BATCH = 100

async function main() {
  console.log('=== 从缓存写入 MongoDB ===\n')

  // 1. 读缓存
  if (!process.env.MONGODB_URI) {
    console.log('MONGODB_URI 未设置')
    return
  }

  console.log('读取缓存...')
  const cached = JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
  console.log(`  缓存共 ${cached.length} 条带向量数据\n`)

  // 2. 连接 MongoDB
  const client = new MongoClient(process.env.MONGODB_URI)
  try {
    await client.connect()
    console.log('MongoDB 连接成功')
    const db = client.db(process.env.MONGODB_DB || 'test')
    const col = db.collection('resources')

    // 3. 快速查重：集合为空则跳过
    const docCount = await col.countDocuments()
    console.log(`  集合现有 ${docCount} 条文档`)

    let toInsert: any[]
    if (docCount === 0) {
      toInsert = cached
      console.log(`  集合为空，全部 ${toInsert.length} 条为新数据`)
    } else {
      console.log('检查重复项（分批查询）...')
      const keys = cached.map((c: any) => c.dedupKey)
      const existingKeys = new Set<string>()
      for (let i = 0; i < keys.length; i += 2000) {
        const batchKeys = keys.slice(i, i + 2000)
        const docs = await col.find(
          { dedupKey: { $in: batchKeys } },
          { projection: { dedupKey: 1 } },
        ).toArray()
        for (const d of docs) existingKeys.add((d as any).dedupKey)
        console.log(`  dedup 进度: ${Math.min(i + 2000, keys.length)}/${keys.length}`)
      }
      toInsert = cached.filter((c: any) => !existingKeys.has(c.dedupKey))
      console.log(`  已有 ${existingKeys.size} 条重复，新增 ${toInsert.length} 条`)
    }

    if (toInsert.length === 0) {
      console.log('无新增数据，跳过。')
      return
    }

    // 4. 分批写入
    console.log('写入 MongoDB...')
    let inserted = 0
    for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
      const batch = toInsert.slice(i, i + INSERT_BATCH)
      const docs = batch.map((c: any) => ({
        content: c.content,
        embedding: c.embedding,
        metadata: c.metadata,
        dedupKey: c.dedupKey,
      }))
      const r = await col.insertMany(docs, { ordered: false })
      inserted += r.insertedCount
      console.log(`  进度: ${Math.min(i + INSERT_BATCH, toInsert.length)}/${toInsert.length}`)
    }
    console.log(`\n完成！成功写入 ${inserted} 条`)
  } finally {
    await client.close()
  }
}

main().catch(console.error)
