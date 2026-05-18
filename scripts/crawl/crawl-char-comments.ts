import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fetchHTML, charCommentsUrl } from '../lib/crawl/fetcher'
import { parseCharComments } from '../lib/crawl/parsers/char-comment-parser'
import { REQUEST_DELAY_MS } from '../lib/crawl/config'

const parsedDir = path.resolve('scripts/data/parsed')

async function saveJSON(filename: string, data: unknown) {
  const dir = path.join(parsedDir, 'char-comments')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

async function main() {
  console.log('=== 爬取角色评论 ===\n')

  // 收集唯一角色 ID（按角色，会跨游戏重复出现）
  const charsDir = path.join(parsedDir, 'characters')
  const files = await readdir(charsDir)
  const charIds = new Set<number>()

  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const data = JSON.parse(await readFile(path.join(charsDir, f), 'utf-8'))
    for (const c of data) {
      charIds.add(c.id)
    }
  }

  // 排除已有缓存 / 已经爬过的
  const charCommentsDir = path.join(parsedDir, 'char-comments')
  let alreadyDone = 0
  const toFetch: number[] = []
  for (const id of charIds) {
    const cachePath = path.join(charCommentsDir, `${id}.json`)
    try {
      await readFile(cachePath, 'utf-8')
      alreadyDone++
    } catch {
      toFetch.push(id)
    }
  }

  console.log(`共 ${charIds.size} 个角色`)
  console.log(`已爬: ${alreadyDone}，待爬: ${toFetch.length}\n`)

  if (toFetch.length === 0) {
    console.log('全部已完成。')
    return
  }

  // 估算时间
  const estMin = Math.round((toFetch.length * REQUEST_DELAY_MS) / 60000)
  console.log(`预计耗时约 ${estMin} 分钟（每请求间隔 ${REQUEST_DELAY_MS}ms）\n`)

  let totalComments = 0
  let emptyChars = 0

  for (let i = 0; i < toFetch.length; i++) {
    const id = toFetch[i]
    const { url, cacheKey } = charCommentsUrl(id)

    try {
      const html = await fetchHTML(url, cacheKey, { noCookie: true })
      const comments = parseCharComments(html)
      await saveJSON(`${id}.json`, comments)
      totalComments += comments.length
      if (comments.length === 0) emptyChars++

      if ((i + 1) % 100 === 0) {
        console.log(`  [${i + 1}/${toFetch.length}] 已完成，累计 ${totalComments} 条评论`)
      }
    } catch (err) {
      console.error(`  [失败] 角色 ${id}: ${(err as Error).message}`)
    }
  }

  console.log(`\n=== 完成 ===`)
  console.log(`处理角色: ${toFetch.length} 个`)
  console.log(`新增评论: ${totalComments} 条`)
  console.log(`空评论角色: ${emptyChars} 个`)
  console.log(`数据已保存到 parsed/char-comments/`)
}

main().catch(console.error)
