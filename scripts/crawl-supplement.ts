/**
 * 补爬缺失的排行榜数据
 *
 * rank-page-2/5/7 爬取时 Bangumi 返回 502 被缓存，导致约 70 个游戏缺失。
 * 此脚本：
 *   1. 重新爬取第 2/5/7 页排行榜
 *   2. 与现有 game-list.json 对比，找出新游戏
 *   3. 对新游戏逐个获取详情/角色/评论/长评（含全文）
 *   4. 保存到 parsed/ 目录 & 合并到 game-list.json
 */
import 'dotenv/config'
import path from 'node:path'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { fetchHTML, fetchAPI, rankUrl, commentsUrl, reviewsUrl, blogUrl } from './lib/fetcher'
import { fetchHTMLviaBrowser } from './lib/browser-fetcher'
import { parseGameList } from './lib/rank-parser'
import { parseGameDetailFromAPI } from './lib/game-parser'
import { parseComments, parseReviews } from './lib/comment-parser'
import { parseBlogContent } from './lib/blog-parser'
import { RANK_PAGES, MIN_RATING_COUNT } from './lib/config'
import type { GameListItem, CharacterInfo, Review } from './lib/types'

const PARSED_DIR = path.resolve('scripts/data/parsed')
const RAW_DIR = path.resolve('scripts/data/raw')
const MAX_DETAIL_CHARS = 20

async function saveJSON(dir: string, filename: string, data: unknown) {
  const fullDir = path.join(PARSED_DIR, dir)
  await mkdir(fullDir, { recursive: true })
  await writeFile(path.join(fullDir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

async function fetchFullReviewHTML(blogId: number): Promise<string> {
  const { url, cacheKey } = blogUrl(blogId)
  const cachePath = path.join(RAW_DIR, `${cacheKey}.html`)
  try {
    return await fetchHTML(url, cacheKey)
  } catch {
    console.log(`      → 浏览器模式 blog/${blogId}...`)
    const html = await fetchHTMLviaBrowser(url)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, html, 'utf-8')
    return html
  }
}

async function main() {
  console.log('=== 补爬缺失的排行榜数据 ===\n')

  // 1. 加载现有 game-list
  const existingPath = path.join(PARSED_DIR, 'game-list.json')
  const existingGames: GameListItem[] = JSON.parse(await readFile(existingPath, 'utf-8'))
  const existingIds = new Set(existingGames.map(g => g.id))
  console.log(`现有游戏: ${existingGames.length} 个`)

  // 2. 重新爬取第 2/5/7 页
  console.log('重新爬取排行榜（第 2/5/7 页）...')
  const missingPages = [2, 5, 7]
  const newRawGames: GameListItem[] = []

  for (const page of missingPages) {
    const { url, cacheKey } = rankUrl(page)
    console.log(`  第 ${page} 页...`)
    const html = await fetchHTML(url, cacheKey)
    const items = parseGameList(html)
    console.log(`    → ${items.length} 个游戏`)
    newRawGames.push(...items)
  }

  // 3. 去重 + 筛选 + 找出新游戏
  const seen = new Set<number>()
  const uniqueNew = newRawGames
    .filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true })
    .sort((a, b) => a.rank - b.rank)
    .filter(g => g.ratingCount > MIN_RATING_COUNT)

  const trulyNew = uniqueNew.filter(g => !existingIds.has(g.id))
  console.log(`\n新游戏: ${trulyNew.length} 个`)
  for (const g of trulyNew) {
    console.log(`  rank=${g.rank} id=${g.id} ${g.name} (${g.ratingCount}评)`)
  }

  if (trulyNew.length === 0) {
    console.log('无需补爬，退出。')
    return
  }

  // 4. 逐个获取新游戏数据
  console.log('\n获取新游戏数据...')
  const failedGames: Array<{ id: number; name: string; reason: string }> = []

  for (let i = 0; i < trulyNew.length; i++) {
    const game = trulyNew[i]
    console.log(`[${i + 1}/${trulyNew.length}] ${game.name} (${game.id})`)

    try {
      // 4a. 游戏详情（API）
      const subjectData = await fetchAPI(`/v0/subjects/${game.id}`)
      const detail = parseGameDetailFromAPI(game.id, subjectData)

      // 4b. 角色列表（API）
      const allChars: CharacterInfo[] = []
      try {
        const charListData = await fetchAPI(`/v0/subjects/${game.id}/characters`)
        if (Array.isArray(charListData)) {
          const relationRank: Record<string, number> = { '主角': 0, '配角': 1 }
          const sorted = (charListData as any[])
            .map(c => ({ ...c, _rank: relationRank[c.relation] ?? 2 }))
            .sort((a, b) => a._rank - b._rank)

          for (let ci = 0; ci < sorted.length; ci++) {
            const c = sorted[ci]
            const basic: CharacterInfo = {
              id: c.id,
              name: c.name ?? '',
              nameCN: '',
              summary: (c.summary ?? '').replace(/<[^>]+>/g, '').trim(),
              gender: '',
              birthYear: null,
              birthMon: null,
              birthDay: null,
              imageUrl: c.images?.medium ?? c.images?.large ?? '',
              cvName: c.actors?.[0]?.name ?? '',
              subjectId: game.id,
              relation: c.relation ?? '',
            }
            if (ci < MAX_DETAIL_CHARS) {
              try {
                const detailChar = await fetchAPI(`/v0/characters/${c.id}`)
                basic.nameCN = detailChar.name_cn ?? ''
                basic.gender = detailChar.gender ?? ''
                basic.birthYear = detailChar.birth?.year ?? null
                basic.birthMon = detailChar.birth?.mon ?? null
                basic.birthDay = detailChar.birth?.day ?? null
              } catch { /* fallback */ }
            }
            allChars.push(basic)
          }
        }
      } catch { /* skip */ }
      console.log(`  角色: ${allChars.length} 个`)

      // 4c. 短评（HTML，3 页）
      const allComments: any[] = []
      for (let p = 1; p <= 3; p++) {
        try {
          const { url: cUrl, cacheKey: cKey } = commentsUrl(game.id, p)
          const cHtml = await fetchHTML(cUrl, cKey)
          allComments.push(...parseComments(cHtml))
        } catch { break }
      }
      console.log(`  短评: ${allComments.length} 条`)

      // 4d. 长评列表 + 全文补爬
      const allReviews: Review[] = []
      try {
        const { url: rUrl, cacheKey: rKey } = reviewsUrl(game.id)
        const rHtml = await fetchHTML(rUrl, rKey)
        allReviews.push(...parseReviews(rHtml))

        // 补爬全文
        for (let ri = 0; ri < allReviews.length; ri++) {
          const rev = allReviews[ri]
          try {
            const blogHtml = await fetchFullReviewHTML(rev.id)
            rev.fullContent = parseBlogContent(blogHtml)
          } catch {
            // 全文拿不到就算，用 summary 兜底
          }
          if ((ri + 1) % 5 === 0) process.stdout.write('.')
        }
      } catch { /* no reviews */ }
      console.log(`\n  长评: ${allReviews.length} 篇`)

      // 保存
      await saveJSON('games', `${game.id}.json`, detail)
      await saveJSON('comments', `${game.id}.json`, allComments)
      await saveJSON('reviews', `${game.id}.json`, allReviews)
      await saveJSON('characters', `${game.id}.json`, allChars)
    } catch (err) {
      const reason = (err as Error).message || String(err)
      console.error(`  [失败] ${game.name}: ${reason}`)
      failedGames.push({ id: game.id, name: game.name, reason })
    }
  }

  // 5. 合并到 game-list.json
  const merged = [...existingGames, ...trulyNew]
    .sort((a, b) => a.rank - b.rank)
  await saveJSON('', 'game-list.json', merged)
  console.log(`\ngame-list.json 已更新: ${merged.length} 个游戏`)

  // 6. 失败记录
  if (failedGames.length > 0) {
    console.error(`\n失败: ${failedGames.length} 个`)
    for (const f of failedGames) {
      console.error(`  ${f.name} (${f.id}): ${f.reason}`)
    }
  }

  console.log('\n=== 补爬完成 ===')
  console.log(`新增游戏: ${trulyNew.length} 个`)
  for (const g of trulyNew) {
    console.log(`  ${g.name} (${g.id})`)
  }
  console.log('\n下一步: pnpm tsx scripts/embed-supplement.ts')
}

main().catch(console.error)
