/**
 * 为已有游戏补爬更多短评页和长评页
 *
 * 背景：当前短评只爬了 3 页，长评只爬了 1 页。
 * 此脚本遍历所有已有游戏，补爬更多页并合并到现有 parsed JSON。
 *
 * 用法：
 *   pnpm tsx scripts/crawl-more-pages.ts
 *
 * 流程：
 *   1. 读取 parsed/games/ 下所有游戏 ID
 *   2. 每个游戏：补爬短评第 4~20 页 + 长评第 1~10 页
 *   3. 与现有数据合并去重，保存回 parsed/ 目录
 */
import 'dotenv/config'
import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fetchHTML, commentsUrl, reviewsUrl } from '../lib/crawl/fetcher'
import { parseComments, parseReviews } from '../lib/crawl/parsers/comment-parser'
import type { Comment, Review } from '../lib/crawl/types'

const PARSED_DIR = path.resolve('scripts/data/parsed')

/** 简单 hash（同 embed-supplement.ts） */
function hashCode(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

async function main() {
  console.log('=== 补爬更多短评 + 长评页 ===\n')

  // 1. 获取所有游戏 ID
  const gameFiles = await readdir(path.join(PARSED_DIR, 'games'))
  const gameIds = gameFiles
    .filter(f => f.endsWith('.json'))
    .map(f => parseInt(f.replace('.json', ''), 10))
    .filter(id => !isNaN(id))
    .sort((a, b) => a - b)

  console.log(`共 ${gameIds.length} 个游戏\n`)

  // 2. 遍历每个游戏，补爬评论和长评
  let totalNewComments = 0
  let totalNewReviews = 0
  let gamesWithNewComments = 0
  let gamesWithNewReviews = 0

  for (let i = 0; i < gameIds.length; i++) {
    const gameId = gameIds[i]
    const progress = `[${i + 1}/${gameIds.length}]`

    // ---- 短评：爬第 4~20 页 ----
    let existingComments: Comment[] = []
    try {
      existingComments = JSON.parse(
        await readFile(path.join(PARSED_DIR, 'comments', `${gameId}.json`), 'utf-8'),
      )
    } catch {
      existingComments = []
    }

    const existingCommentHashes = new Set(existingComments.map(c => hashCode(c.text)))
    const newComments: Comment[] = []
    for (let p = 4; p <= 20; p++) {
      try {
        const { url, cacheKey } = commentsUrl(gameId, p)
        const html = await fetchHTML(url, cacheKey)
        const items = parseComments(html)
        for (const item of items) {
          const h = hashCode(item.text)
          if (!existingCommentHashes.has(h)) {
            existingCommentHashes.add(h)
            newComments.push(item)
          }
        }
      } catch {
        break // 空页或错误，停止翻页
      }
    }

    if (newComments.length > 0) {
      const merged = [...existingComments, ...newComments]
      await writeFile(
        path.join(PARSED_DIR, 'comments', `${gameId}.json`),
        JSON.stringify(merged, null, 2),
        'utf-8',
      )
      totalNewComments += newComments.length
      gamesWithNewComments++
    }

    // ---- 长评：爬第 1~10 页 ----
    let existingReviews: Review[] = []
    try {
      existingReviews = JSON.parse(
        await readFile(path.join(PARSED_DIR, 'reviews', `${gameId}.json`), 'utf-8'),
      )
    } catch {
      existingReviews = []
    }

    const existingReviewIds = new Set(existingReviews.map(r => r.id))
    const newReviews: Review[] = []
    for (let p = 1; p <= 10; p++) {
      try {
        const { url, cacheKey } = reviewsUrl(gameId, p)
        const html = await fetchHTML(url, cacheKey)
        const items = parseReviews(html)
        for (const item of items) {
          if (!existingReviewIds.has(item.id)) {
            existingReviewIds.add(item.id)
            newReviews.push(item)
          }
        }
      } catch {
        break
      }
    }

    if (newReviews.length > 0) {
      // 保留已有 fullContent（新 review 没有全文，以后可单独补爬）
      const merged = [...existingReviews, ...newReviews]
      await writeFile(
        path.join(PARSED_DIR, 'reviews', `${gameId}.json`),
        JSON.stringify(merged, null, 2),
        'utf-8',
      )
      totalNewReviews += newReviews.length
      gamesWithNewReviews++
    }

    if (newComments.length > 0 || newReviews.length > 0) {
      console.log(
        `${progress} game:${gameId} → 新增短评 ${newComments.length} 条, 长评 ${newReviews.length} 篇`,
      )
    } else if ((i + 1) % 30 === 0) {
      // 静默进度
      console.log(`${progress} 无新增`)
    }
  }

  // 3. 汇总
  console.log('\n=== 补爬完成 ===')
  console.log(`统计：`)
  console.log(`  处理游戏: ${gameIds.length} 个`)
  console.log(`  有新增短评的游戏: ${gamesWithNewComments} 个`)
  console.log(`  有新增长评的游戏: ${gamesWithNewReviews} 个`)
  console.log(`  新增短评总数: ${totalNewComments} 条`)
  console.log(`  新增长评总数: ${totalNewReviews} 篇`)
  console.log(`\n下一步: pnpm tsx scripts/embed-supplement.ts`)
}

main().catch(console.error)
