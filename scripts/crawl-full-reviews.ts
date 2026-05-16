import path from 'node:path'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fetchHTML, blogUrl } from './lib/fetcher'
import { fetchHTMLviaBrowser } from './lib/browser-fetcher'
import { parseBlogContent } from './lib/blog-parser'
import type { Review } from './lib/types'

const reviewsDir = path.resolve('scripts/data/parsed/reviews')
const rawDir = path.resolve('scripts/data/raw')

async function fetchFullReview(id: number): Promise<string> {
  const { url, cacheKey } = blogUrl(id)

  // 先试普通 fetch（带 cookie）
  try {
    return await fetchHTML(url, cacheKey)
  } catch {
    // R18 被拦，走浏览器
    console.log(`    → 浏览器模式获取 blog/${id}...`)
    const html = await fetchHTMLviaBrowser(url)
    // 写缓存
    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    const cachePath = path.join(rawDir, `${cacheKey}.html`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await wf(cachePath, html, 'utf-8')
    return html
  }
}

async function main() {
  console.log('=== 补爬长评全文 ===\n')

  const files = (await readdir(reviewsDir)).filter(f => f.endsWith('.json'))
  let total = 0
  let skipped = 0
  let fetched = 0
  let failed = 0

  for (const f of files) {
    const filePath = path.join(reviewsDir, f)
    const reviews: Review[] = JSON.parse(await readFile(filePath, 'utf-8'))
    let changed = false

    for (const review of reviews) {
      total++
      if (review.fullContent) {
        skipped++
        continue
      }

      try {
        const html = await fetchFullReview(review.id)
        const text = parseBlogContent(html)

        if (text) {
          review.fullContent = text
          changed = true
          fetched++
          const preview = text.substring(0, 60).replace(/\n/g, ' ')
          console.log(`  [OK] blog/${review.id}: ${preview}...`)
        } else {
          // 有 HTML 但解析不出内容，可能是页面结构变了
          review.fullContent = ''
          changed = true
          fetched++
          console.log(`  [空] blog/${review.id}`)
        }
      } catch (err) {
        failed++
        console.error(`  [失败] blog/${review.id}: ${(err as Error).message}`)
      }
    }

    if (changed) {
      await writeFile(filePath, JSON.stringify(reviews, null, 2), 'utf-8')
    }
  }

  console.log(`\n=== 完成 ===`)
  console.log(`总计: ${total} 篇`)
  console.log(`已跳过（已有全文）: ${skipped}`)
  console.log(`新增: ${fetched}`)
  console.log(`失败: ${failed}`)
}

main().catch(console.error)
