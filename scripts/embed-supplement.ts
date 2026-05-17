/**
 * 为补爬的新数据生成 embedding，追加到缓存
 *
 * 1. 读取新游戏的 ID 列表
 * 2. 只读取这些 ID 对应的 parsed 数据
 * 3. 分块、生成 embedding
 * 4. 追加到 embedded-chunks.json
 *
 * 用法：
 *   pnpm tsx scripts/embed-supplement.ts --ids=935,xxx,yyy
 *   # 或自动从 game-list.json 找新游戏：pnpm tsx scripts/embed-supplement.ts
 */
import 'dotenv/config'
import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { generateEmbeddings } from '../src/lib/ai/embedding'

const PARSED_DIR = path.resolve('scripts/data/parsed')
const CACHE_PATH = path.resolve('scripts/data/cache/embedded-chunks.json')
const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 50
const MIN_COMMENT_LEN = 15
const MIN_CHAR_COMMENT_LEN = 20
const EMBED_BATCH = 20

interface GameDetail {
  id: number; name: string; nameCN: string; summary: string
}
interface Comment {
  userId: string; userName: string; text: string; score: number; date: string
}
interface Review {
  id: number; title: string; summary: string; fullContent?: string
  author: string; date: string
}
interface CharacterInfo {
  id: number; name: string; nameCN: string; summary: string; subjectId: number
}
interface RawChunk {
  content: string; metadata: Record<string, any>; dedupKey: string
}

function chunkText(text: string, maxSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (!text || text.length <= maxSize) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    if (text.length - start <= maxSize) {
      chunks.push(text.slice(start)); break
    }
    const segment = text.slice(start, start + maxSize)
    let splitAt = -1
    for (const sep of ['\n\n', '\n', '。', '！', '？', '，', '、', ' ']) {
      splitAt = segment.lastIndexOf(sep); if (splitAt >= 0) break
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

function hashCode(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0 }
  return Math.abs(hash).toString(36)
}

function parseIds(input: string): number[] {
  return input.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
}

async function loadGameNames(gameIds: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  for (const id of gameIds) {
    try {
      const data: GameDetail = JSON.parse(await readFile(path.join(PARSED_DIR, 'games', `${id}.json`), 'utf-8'))
      map.set(id, data.nameCN || data.name)
    } catch { /* no game file */ }
  }
  return map
}

async function loadCharNames(gameIds: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  for (const id of gameIds) {
    try {
      const items: CharacterInfo[] = JSON.parse(await readFile(path.join(PARSED_DIR, 'characters', `${id}.json`), 'utf-8'))
      for (const item of items) map.set(item.id, item.nameCN || item.name)
    } catch { /* no char file */ }
  }
  return map
}

async function main() {
  console.log('=== 为新数据生成 embedding ===\n')

  // 1. 确定要处理的游戏 ID
  let targetIds: Set<number>
  const idArg = process.argv.find(a => a.startsWith('--ids='))
  if (idArg) {
    targetIds = new Set(parseIds(idArg.replace('--ids=', '')))
  } else {
    // 自动：用 game-list.json 中所有游戏，过滤已有 chunks 的 dedupKey
    const gameList: any[] = JSON.parse(await readFile(path.join(PARSED_DIR, 'game-list.json'), 'utf-8'))
    targetIds = new Set(gameList.map(g => g.id))
  }
  console.log(`目标游戏: ${targetIds.size} 个`)

  // 2. 加载映射表
  const gameNames = await loadGameNames(targetIds)
  const charNames = await loadCharNames(targetIds)
  console.log(`加载到 ${gameNames.size} 个游戏名, ${charNames.size} 个角色名`)

  // 3. 读取新游戏的 parsed 数据
  const allChunks: RawChunk[] = []

  for (const gameId of targetIds) {
    // game_intro
    try {
      const data: GameDetail = JSON.parse(await readFile(path.join(PARSED_DIR, 'games', `${gameId}.json`), 'utf-8'))
      if (data.summary?.trim()?.length >= 15) {
        allChunks.push({
          content: data.summary.trim(),
          metadata: { type: 'game_intro', source: `game:${gameId}`, gameName: gameNames.get(gameId) || '' },
          dedupKey: `game_intro:game:${gameId}`,
        })
      }
    } catch { /* ok */ }

    // comments
    try {
      const items: Comment[] = JSON.parse(await readFile(path.join(PARSED_DIR, 'comments', `${gameId}.json`), 'utf-8'))
      for (const item of items) {
        const text = item.text?.trim()
        if (!text || text.length < MIN_COMMENT_LEN || text === '删除了回复') continue
        allChunks.push({
          content: text,
          metadata: { type: 'comment', source: `game:${gameId}`, gameName: gameNames.get(gameId) || '' },
          dedupKey: `comment:game:${gameId}:${hashCode(text)}`,
        })
      }
    } catch { /* ok */ }

    // reviews
    try {
      const items: Review[] = JSON.parse(await readFile(path.join(PARSED_DIR, 'reviews', `${gameId}.json`), 'utf-8'))
      for (const item of items) {
        const text = (item.fullContent || item.summary)?.trim()
        if (!text || text.length < 15) continue
        const subChunks = chunkText(text)
        for (let i = 0; i < subChunks.length; i++) {
          const sub = subChunks[i].trim()
          if (!sub) continue
          allChunks.push({
            content: sub,
            metadata: { type: 'review', source: `game:${gameId}`, gameName: gameNames.get(gameId) || '', chunkIndex: i, totalChunks: subChunks.length },
            dedupKey: `review:game:${gameId}:blog:${item.id}:chunk:${i}`,
          })
        }
      }
    } catch { /* ok */ }

    // characters
    try {
      const items: CharacterInfo[] = JSON.parse(await readFile(path.join(PARSED_DIR, 'characters', `${gameId}.json`), 'utf-8'))
      for (const item of items) {
        const text = item.summary?.trim()
        if (!text || text.length < MIN_COMMENT_LEN) continue
        allChunks.push({
          content: text,
          metadata: { type: 'character', source: `char:${item.id}`, gameName: gameNames.get(gameId) || '', charName: item.nameCN || item.name },
          dedupKey: `character:char:${item.id}`,
        })
      }
    } catch { /* ok */ }
  }

  console.log(`\n总计 ${allChunks.length} 条待嵌入`)

  if (allChunks.length === 0) {
    console.log('无数据，退出。')
    return
  }

  // 4. 去重（对 embedded-chunks.json 去重）
  let existingDedupKeys = new Set<string>()
  try {
    const existing = JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
    if (Array.isArray(existing)) {
      existingDedupKeys = new Set(existing.map((c: any) => c.dedupKey))
      console.log(`已有缓存: ${existing.length} 条`)
    }
  } catch { console.log('无现有缓存，从头创建') }

  const toEmbed = allChunks.filter(c => !existingDedupKeys.has(c.dedupKey))
  console.log(`去重后新增: ${toEmbed.length} 条`)

  if (toEmbed.length === 0) {
    console.log('无新增，退出。')
    return
  }

  // 5. 生成 embedding
  console.log('\n生成 embedding...')
  const embedded: Array<RawChunk & { embedding: number[] }> = []
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    const batch = toEmbed.slice(i, i + EMBED_BATCH)
    const texts = batch.map(c => c.content)
    const embeddings = await generateEmbeddings(texts)
    for (let j = 0; j < batch.length; j++) {
      embedded.push({ ...batch[j], embedding: embeddings[j] })
    }
    const done = Math.min(i + EMBED_BATCH, toEmbed.length)
    if (done % 100 === 0 || done === toEmbed.length) {
      console.log(`  ${done}/${toEmbed.length}`)
    }
  }

  // 6. 追加到缓存
  let existingEmbedded: any[] = []
  try {
    existingEmbedded = JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
    if (!Array.isArray(existingEmbedded)) existingEmbedded = []
  } catch { /* fresh file */ }

  const merged = [...existingEmbedded, ...embedded]
  await mkdir(path.dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, JSON.stringify(merged), 'utf-8')
  console.log(`\n缓存已更新: ${existingEmbedded.length} → ${merged.length} 条`)

  console.log('\n=== 完成 ===')
  console.log(`下一步: pnpm tsx scripts/load-to-qdrant.ts`)
}

main().catch(console.error)
