import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import type { CrawlResult } from './lib/types'

const parsedDir = path.resolve('scripts/data/parsed')

async function main() {
  const gamesDir = path.join(parsedDir, 'games')
  let count = 0

  const files = await readdir(gamesDir)
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.replace('.json', '')

    const content = await readFile(path.join(gamesDir, file), 'utf-8')
    const data: CrawlResult & { game?: any } = JSON.parse(content)

    // 已拆分过的跳过（没有 CrawlResult 结构）
    if (!data.comments && !data.characters && !data.reviews) continue

    await saveJSON('games', `${id}.json`, data.game ?? data)
    await saveJSON('comments', `${id}.json`, data.comments ?? [])
    await saveJSON('reviews', `${id}.json`, data.reviews ?? [])
    await saveJSON('characters', `${id}.json`, data.characters ?? [])

    count++
  }

  console.log(`拆分完成：${count} 个游戏`)
  console.log('目录结构: parsed/{games,comments,reviews,characters}/{id}.json')
}

async function saveJSON(dir: string, filename: string, data: unknown) {
  const fullDir = path.join(parsedDir, dir)
  await mkdir(fullDir, { recursive: true })
  await writeFile(path.join(fullDir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

main().catch(console.error)
