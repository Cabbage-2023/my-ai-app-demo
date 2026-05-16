import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fetchHTML, commentsUrl, reviewsUrl } from './lib/fetcher'
import { fetchHTMLviaBrowser } from './lib/browser-fetcher'
import { parseComments, parseReviews } from './lib/comment-parser'

const parsedDir = path.resolve('scripts/data/parsed')
const rawDir = path.resolve('scripts/data/raw')

async function saveJSON(dir: string, filename: string, data: unknown) {
  const fullDir = path.join(parsedDir, dir)
  await mkdir(fullDir, { recursive: true })
  await writeFile(path.join(fullDir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

async function fetchNSFW(url: string, cacheKey: string): Promise<string> {
  // 先试缓存 + 普通 fetch
  try {
    return await fetchHTML(url, cacheKey)
  } catch {
    // 普通 fetch 失败（R18 拦截），走浏览器
    console.log(`    → 浏览器模式获取...`)
    const html = await fetchHTMLviaBrowser(url)
    // 写入缓存
    const cachePath = path.join(rawDir, `${cacheKey}.html`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, html, 'utf-8')
    return html
  }
}

async function main() {
  console.log('=== 补爬 NSFW 游戏评论 ===\n')

  // 读取所有已保存的游戏详情，找出 NSFW 游戏
  const gamesDir = path.join(parsedDir, 'games')
  const files = await readdir(gamesDir)
  const nsfwGames: { id: number; name: string }[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const raw = await readFile(path.join(gamesDir, file), 'utf-8')
    const data = JSON.parse(raw)
    if (data.nsfw) {
      nsfwGames.push({ id: data.id, name: data.name || data.nameCN || file })
    }
  }

  console.log(`找到 ${nsfwGames.length} 个 NSFW 游戏，开始补爬评论...\n`)

  let totalComments = 0
  let totalReviews = 0

  for (let i = 0; i < nsfwGames.length; i++) {
    const g = nsfwGames[i]
    console.log(`  [${i + 1}/${nsfwGames.length}] ${g.name} (${g.id})`)

    // 短评（取前 3 页）
    const comments: any[] = []
    for (let p = 1; p <= 3; p++) {
      try {
        const { url, cacheKey } = commentsUrl(g.id, p)
        const html = await fetchNSFW(url, cacheKey)
        comments.push(...parseComments(html))
      } catch {
        break
      }
    }
    console.log(`    短评: ${comments.length} 条`)
    await saveJSON('comments', `${g.id}.json`, comments)
    totalComments += comments.length

    // 长评
    let reviews: any[] = []
    try {
      const { url, cacheKey } = reviewsUrl(g.id)
      const html = await fetchNSFW(url, cacheKey)
      reviews = parseReviews(html)
    } catch {
      // 无长评
    }
    console.log(`    长评: ${reviews.length} 篇`)
    await saveJSON('reviews', `${g.id}.json`, reviews)
    totalReviews += reviews.length

    if ((i + 1) % 10 === 0) {
      console.log(`  --- 已完成 ${i + 1}/${nsfwGames.length} ---`)
    }
  }

  console.log(`\n=== 完成 ===`)
  console.log(`共补爬 ${nsfwGames.length} 个 NSFW 游戏`)
  console.log(`新增短评: ${totalComments} 条`)
  console.log(`新增长评: ${totalReviews} 篇`)
}

main().catch(console.error)
