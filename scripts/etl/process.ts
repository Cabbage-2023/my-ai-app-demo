import 'dotenv/config'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { MongoClient } from 'mongodb'
import { generateEmbeddings } from '../../src/lib/ai/embedding'

const parsedDir = path.resolve('scripts/data/parsed')

// --------------- types ---------------

interface GameDetail {
  id: number
  name: string
  nameCN: string
  summary: string
}

interface Comment {
  userId: string
  userName: string
  text: string
  score: number
  date: string
}

interface Review {
  id: number
  title: string
  summary: string
  fullContent?: string
  author: string
  date: string
}

interface CharacterInfo {
  id: number
  name: string
  nameCN: string
  summary: string
  subjectId: number
}

// --------------- config ---------------

const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 50
const MIN_COMMENT_LEN = 15
const MIN_CHAR_COMMENT_LEN = 20
const DEDUP_BATCH = 2000
const EMBED_BATCH = 20
const INSERT_BATCH = 500   // MongoDB 分批写入，防 16MB BSON 上限

// --------------- 中文递归分割器 ---------------

function chunkText(text: string, maxSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (!text || text.length <= maxSize) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    if (text.length - start <= maxSize) {
      chunks.push(text.slice(start))
      break
    }

    const segment = text.slice(start, start + maxSize)
    let splitAt = -1

    for (const sep of ['\n\n', '\n', '。', '！', '？', '，', '、', ' ']) {
      splitAt = segment.lastIndexOf(sep)
      if (splitAt >= 0) break
    }

    if (splitAt < maxSize * 0.25) splitAt = maxSize
    if (splitAt === maxSize) {
      const lastSpace = segment.lastIndexOf(' ', maxSize - 1)
      if (lastSpace > maxSize * 0.5) splitAt = lastSpace
    }

    chunks.push(text.slice(start, start + splitAt + 1))
    start = start + splitAt + 1 - overlap
    if (start >= text.length) break
  }

  return chunks
}

// --------------- 映射加载 ---------------

async function loadGameNames(): Promise<Map<number, string>> {
  const dir = path.join(parsedDir, 'games')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const map = new Map<number, string>()
  for (const f of files) {
    const gameId = parseInt(f.replace('.json', ''), 10)
    const data: GameDetail = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))
    map.set(gameId, data.nameCN || data.name)
  }
  return map
}

async function loadCharNames(): Promise<Map<number, string>> {
  const dir = path.join(parsedDir, 'characters')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const map = new Map<number, string>()
  for (const f of files) {
    const items: CharacterInfo[] = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))
    for (const item of items) {
      map.set(item.id, item.nameCN || item.name)
    }
  }
  return map
}

// --------------- 各类型加载 ---------------

interface RawChunk {
  content: string
  metadata: Record<string, any>
  dedupKey: string
}

async function loadGames(gameNames: Map<number, string>): Promise<RawChunk[]> {
  const dir = path.join(parsedDir, 'games')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const result: RawChunk[] = []

  for (const f of files) {
    const gameId = parseInt(f.replace('.json', ''), 10)
    const data: GameDetail = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))
    const text = data.summary?.trim()
    if (!text || text.length < 15) continue

    result.push({
      content: text,
      metadata: {
        type: 'game_intro',
        source: `game:${gameId}`,
        gameName: gameNames.get(gameId) || '',
      },
      dedupKey: `game_intro:game:${gameId}`,
    })
  }

  return result
}

async function loadComments(gameNames: Map<number, string>): Promise<RawChunk[]> {
  const dir = path.join(parsedDir, 'comments')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const result: RawChunk[] = []

  for (const f of files) {
    const gameId = parseInt(f.replace('.json', ''), 10)
    const items: Comment[] = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))

    for (const item of items) {
      const text = item.text?.trim()
      if (!text || text.length < MIN_COMMENT_LEN || text === '删除了回复') continue

      result.push({
        content: text,
        metadata: {
          type: 'comment',
          source: `game:${gameId}`,
          gameName: gameNames.get(gameId) || '',
        },
        dedupKey: `comment:game:${gameId}:${hashCode(text)}`,
      })
    }
  }

  return result
}

async function loadReviews(gameNames: Map<number, string>): Promise<RawChunk[]> {
  const dir = path.join(parsedDir, 'reviews')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const result: RawChunk[] = []

  for (const f of files) {
    const gameId = parseInt(f.replace('.json', ''), 10)
    const items: Review[] = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))

    for (const item of items) {
      const text = (item.fullContent || item.summary)?.trim()
      if (!text || text.length < 15) continue

      const subChunks = chunkText(text)
      for (let i = 0; i < subChunks.length; i++) {
        const sub = subChunks[i].trim()
        if (!sub) continue

        result.push({
          content: sub,
          metadata: {
            type: 'review',
            source: `game:${gameId}`,
            gameName: gameNames.get(gameId) || '',
            chunkIndex: i,
            totalChunks: subChunks.length,
          },
          dedupKey: `review:game:${gameId}:blog:${item.id}:chunk:${i}`,
        })
      }
    }
  }

  return result
}

async function loadCharacters(gameNames: Map<number, string>): Promise<RawChunk[]> {
  const dir = path.join(parsedDir, 'characters')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const result: RawChunk[] = []

  for (const f of files) {
    const gameId = parseInt(f.replace('.json', ''), 10)
    const items: CharacterInfo[] = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))

    for (const item of items) {
      const text = item.summary?.trim()
      if (!text || text.length < MIN_COMMENT_LEN) continue

      result.push({
        content: text,
        metadata: {
          type: 'character',
          source: `char:${item.id}`,
          gameName: gameNames.get(gameId) || '',
          charName: item.nameCN || item.name,
        },
        dedupKey: `character:char:${item.id}`,
      })
    }
  }

  return result
}

async function loadCharComments(charNames: Map<number, string>): Promise<RawChunk[]> {
  const dir = path.join(parsedDir, 'char-comments')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const result: RawChunk[] = []

  for (const f of files) {
    const charId = parseInt(f.replace('.json', ''), 10)
    const items: any[] = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))

    for (const item of items) {
      const text = item.text?.trim()
      if (!text || text.length < MIN_CHAR_COMMENT_LEN || text === '删除了回复') continue

      result.push({
        content: text,
        metadata: {
          type: 'char_review',
          source: `char:${charId}`,
          charName: charNames.get(charId) || '',
        },
        dedupKey: `char_review:char:${charId}:${hashCode(text)}`,
      })
    }
  }

  return result
}

// --------------- 工具 ---------------

function hashCode(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

// --------------- main ---------------

async function main() {
  console.log('=== 批量灌库 ===\n')

  // 1. 加载映射表
  console.log('加载映射表...')
  const gameNames = await loadGameNames()
  const charNames = await loadCharNames()
  console.log(`  ${gameNames.size} 个游戏, ${charNames.size} 个角色\n`)

  // 2. 加载 & 解析所有数据
  const allChunks: RawChunk[] = [
    ...await loadGames(gameNames),
    ...await loadComments(gameNames),
    ...await loadReviews(gameNames),
    ...await loadCharacters(gameNames),
    ...await loadCharComments(charNames),
  ]

  console.log(`待入库: ${allChunks.length} 条`)
  const typeCount = new Map<string, number>()
  for (const c of allChunks) {
    typeCount.set(c.metadata.type, (typeCount.get(c.metadata.type) || 0) + 1)
  }
  for (const [t, n] of typeCount) {
    console.log(`  ${t}: ${n}`)
  }

  // 3. 连接 MongoDB
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.log('\nMONGODB_URI 未设置，跳过数据库写入。')
    return
  }

  const client = new MongoClient(uri)
  try {
    await client.connect()
    console.log('\nMongoDB 连接成功')
    const db = client.db(process.env.MONGODB_DB || 'test')
    const col = db.collection('resources')

    // 4. 去重 —— 分批查 $in
    console.log('检查重复项（分批查询）...')
    const existingKeys = new Set<string>()
    const allDedupKeys = allChunks.map(c => c.dedupKey)
    for (let i = 0; i < allDedupKeys.length; i += DEDUP_BATCH) {
      const batchKeys = allDedupKeys.slice(i, i + DEDUP_BATCH)
      const docs = await col.find(
        { dedupKey: { $in: batchKeys } },
        { projection: { dedupKey: 1 } },
      ).toArray()
      for (const d of docs) {
        existingKeys.add((d as any).dedupKey)
      }
    }
    const toInsert = allChunks.filter(c => !existingKeys.has(c.dedupKey))
    console.log(`  已有 ${existingKeys.size} 条重复，新增 ${toInsert.length} 条`)

    if (toInsert.length === 0) {
      console.log('无新增数据，跳过。')
      return
    }

// 5. 批量生成 embedding
    console.log('生成 embedding...')
    const embedded: Array<{ content: string; metadata: Record<string, any>; dedupKey: string; embedding: number[] }> = []
    for (let i = 0; i < toInsert.length; i += EMBED_BATCH) {
      const batch = toInsert.slice(i, i + EMBED_BATCH)
      const texts = batch.map(c => c.content)
      const embeddings = await generateEmbeddings(texts)
      for (let j = 0; j < batch.length; j++) {
        embedded.push({ ...batch[j], embedding: embeddings[j] })
      }
      if (i % (EMBED_BATCH * 20) === 0) {
        const done = Math.min(i + EMBED_BATCH, toInsert.length)
        console.log(`  ${done}/${toInsert.length}`)
      }
    }

    // 将带向量的数据写一份本地缓存，防止重跑时重新调 API
    const cacheDir = path.resolve('scripts/data/cache')
    const { mkdir, writeFile: writeJson } = await import('node:fs/promises')
    await mkdir(cacheDir, { recursive: true })
    await writeJson(path.join(cacheDir, 'embedded-chunks.json'), JSON.stringify(embedded), 'utf-8')
    console.log(`  embedding 缓存已保存到 cache/embedded-chunks.json`)

    // 6. 分批写入 MongoDB
    console.log('写入 MongoDB...')
    let inserted = 0
    for (let i = 0; i < embedded.length; i += INSERT_BATCH) {
      const batch = embedded.slice(i, i + INSERT_BATCH)
      const docs = batch.map(c => ({
        content: c.content,
        embedding: c.embedding,
        metadata: c.metadata,
        dedupKey: c.dedupKey,
      }))
      const r = await col.insertMany(docs, { ordered: false })
      inserted += r.insertedCount
      console.log(`  写入进度: ${Math.min(i + INSERT_BATCH, embedded.length)}/${embedded.length}`)
    }
    console.log(`成功写入 ${inserted} 条`)
  } finally {
    await client.close()
  }
}

main().catch(console.error)
