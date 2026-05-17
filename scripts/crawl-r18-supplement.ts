/**
 * 为补爬的 R18 游戏补充评论/长评（走 Puppeteer 浏览器）
 *
 * 爬虫阶段 rank-page-2/5/7 新增的 51 个游戏中，
 * 约 26 个 R18 游戏的短评/长评为 0（Bangumi R18 页面拦截）。
 *
 * 复用 crawl-nsfw-comments.ts 的浏览器 fallback 逻辑。
 */
import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fetchHTML, commentsUrl, reviewsUrl, blogUrl } from './lib/fetcher'
import { fetchHTMLviaBrowser } from './lib/browser-fetcher'
import { parseComments, parseReviews } from './lib/comment-parser'
import { parseBlogContent } from './lib/blog-parser'

const PARSED_DIR = path.resolve('scripts/data/parsed')
const RAW_DIR = path.resolve('scripts/data/raw')

async function saveJSON(dir: string, filename: string, data: unknown) {
  const fullDir = path.join(PARSED_DIR, dir)
  await mkdir(fullDir, { recursive: true })
  await writeFile(path.join(fullDir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

/** 先试普通 fetch（带 cookie），失败走 Puppeteer 浏览器 */
async function fetchNSFW(url: string, cacheKey: string): Promise<string> {
  try {
    return await fetchHTML(url, cacheKey)
  } catch {
    console.log(`    → 浏览器模式获取...`)
    const html = await fetchHTMLviaBrowser(url)
    const cachePath = path.join(RAW_DIR, `${cacheKey}.html`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, html, 'utf-8')
    return html
  }
}

async function fetchFullReviewNSFW(blogId: number): Promise<string> {
  const { url, cacheKey } = blogUrl(blogId)
  try {
    return await fetchHTML(url, cacheKey)
  } catch {
    console.log(`      → 浏览器模式 blog/${blogId}...`)
    const html = await fetchHTMLviaBrowser(url)
    const cachePath = path.join(RAW_DIR, `${cacheKey}.html`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, html, 'utf-8')
    return html
  }
}

async function main() {
  console.log('=== 补爬 R18 游戏评论（浏览器 fallback）===\n')

  // 扫描所有游戏，找出短评为 0 的（新增的 R18 游戏 + 之前漏的）
  const gameList: any[] = JSON.parse(await readFile(path.join(PARSED_DIR, 'game-list.json'), 'utf-8'))
  console.log(`游戏总数: ${gameList.length} 个`)

  const needsPatch: { id: number; name: string }[] = []
  for (const g of gameList) {
    try {
      const comments = JSON.parse(await readFile(path.join(PARSED_DIR, 'comments', `${g.id}.json`), 'utf-8'))
      if (!Array.isArray(comments) || comments.length === 0) {
        needsPatch.push({ id: g.id, name: g.name })
      }
    } catch {
      needsPatch.push({ id: g.id, name: g.name })
    }
  }
  console.log(`短评为 0 需补爬: ${needsPatch.length} 个`)

  if (needsPatch.length === 0) {
    console.log('无需补爬，退出。')
    return
  }

  // 3. 逐个补爬
  for (let i = 0; i < needsPatch.length; i++) {
    const g = needsPatch[i]
    console.log(`[${i + 1}/${needsPatch.length}] ${g.name} (${g.id})`)

    // 短评
    const comments: any[] = []
    for (let p = 1; p <= 3; p++) {
      try {
        const { url, cacheKey } = commentsUrl(g.id, p)
        const html = await fetchNSFW(url, cacheKey)
        comments.push(...parseComments(html))
      } catch { break }
    }
    console.log(`  短评: ${comments.length} 条`)
    await saveJSON('comments', `${g.id}.json`, comments)

    // 长评列表
    let reviews: any[] = []
    try {
      const { url, cacheKey } = reviewsUrl(g.id)
      const html = await fetchNSFW(url, cacheKey)
      reviews = parseReviews(html)
      console.log(`  长评: ${reviews.length} 篇`)
    } catch {
      console.log(`  长评: 0 篇（获取失败）`)
    }

    // 长评全文
    for (let ri = 0; ri < reviews.length; ri++) {
      try {
        const blogHtml = await fetchFullReviewNSFW(reviews[ri].id)
        reviews[ri].fullContent = parseBlogContent(blogHtml)
      } catch { /* 全文拿不到用 summary */ }
    }

    await saveJSON('reviews', `${g.id}.json`, reviews)
  }

  console.log(`\n=== 完成: ${needsPatch.length} 个游戏已补爬 ===`)
}

main().catch(console.error)
