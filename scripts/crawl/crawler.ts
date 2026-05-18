import path from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import {
  fetchHTML,
  fetchAPI,
  rankUrl,
  commentsUrl,
  reviewsUrl,
} from '../lib/crawl/fetcher'
import { parseGameList } from '../lib/crawl/parsers/rank-parser'
import { parseGameDetailFromAPI } from '../lib/crawl/parsers/game-parser'
import { parseComments, parseReviews } from '../lib/crawl/parsers/comment-parser'
import { RANK_PAGES, MIN_RATING_COUNT } from '../lib/crawl/config'
import type { GameListItem, CrawlResult, CharacterInfo } from '../lib/crawl/types'

const parsedDir = path.resolve('scripts/data/parsed')

async function saveJSON(dir: string, filename: string, data: unknown) {
  const fullDir = path.join(parsedDir, dir)
  await mkdir(fullDir, { recursive: true })
  await writeFile(path.join(fullDir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

async function main() {
  console.log('=== 开始爬取 Bangumi Galgame 排行榜 ===\n')

  // ── Step 1: 爬排行榜（HTML，无需 cookie） ──
  console.log('[1/4] 爬取排行榜...')
  const allGames: GameListItem[] = []

  for (let page = 1; page <= RANK_PAGES; page++) {
    const { url, cacheKey } = rankUrl(page)
    console.log(`  第 ${page} 页...`)
    const html = await fetchHTML(url, cacheKey)
    const items = parseGameList(html)
    allGames.push(...items)
  }

  // 去重 + 排序
  const seen = new Set<number>()
  const uniqueGames = allGames
    .filter((g) => {
      if (seen.has(g.id)) return false
      seen.add(g.id)
      return true
    })
    .sort((a, b) => a.rank - b.rank)

  // 筛选评分人数 > 500
  const filtered = uniqueGames.filter((g) => g.ratingCount > MIN_RATING_COUNT)

  console.log(`  共获取 ${uniqueGames.length} 个游戏，筛选后 ${filtered.length} 个（评分人数 > ${MIN_RATING_COUNT}）`)
  await saveJSON('', 'game-list.json', filtered)

  // ── Step 2-4: 逐个获取数据 ──
  console.log('\n[2/4] 获取游戏数据...')
  const results: CrawlResult[] = []
  interface FailedGame { id: number; name: string; reason: string }
  const failedGames: FailedGame[] = []

  for (let i = 0; i < filtered.length; i++) {
    const game = filtered[i]
    console.log(`  [${i + 1}/${filtered.length}] ${game.name} (${game.id})`)

    try {
      // 2a. 游戏详情 → API（稳定，无需 cookie）
      const subjectData = await fetchAPI(`/v0/subjects/${game.id}`)
      const detail = parseGameDetailFromAPI(game.id, subjectData)

      // 2b. 角色列表 → API（角色列表含 summary/CV，不用每个都查详情）
      const allChars: CharacterInfo[] = []
      const MAX_DETAIL_CHARS = 20
      try {
        const charListData = await fetchAPI(`/v0/subjects/${game.id}/characters`)
        if (Array.isArray(charListData)) {
          // 按关系排序：主角优先
          const relationRank: Record<string, number> = { '主角': 0, '配角': 1 }
          const sorted = (charListData as any[])
            .map((c) => ({ ...c, _rank: relationRank[c.relation] ?? 2 }))
            .sort((a, b) => a._rank - b._rank)

          console.log(`    角色列表: ${sorted.length} 个`)

          // 全部角色从列表直拿，前 MAX_DETAIL_CHARS 个再补详情（性别/生日）
          for (let ci = 0; ci < sorted.length; ci++) {
            const c = sorted[ci]
            const basic = {
              id: c.id,
              name: c.name ?? '',
              nameCN: '',
              summary: (c.summary ?? '').replace(/<[^>]+>/g, '').trim(),
              gender: '',
              birthYear: null as number | null,
              birthMon: null as number | null,
              birthDay: null as number | null,
              imageUrl: c.images?.medium ?? c.images?.large ?? '',
              cvName: c.actors?.[0]?.name ?? '',
              subjectId: game.id,
              relation: c.relation ?? '',
            }
            if (ci < MAX_DETAIL_CHARS) {
              try {
                const detail = await fetchAPI(`/v0/characters/${c.id}`)
                basic.nameCN = detail.name_cn ?? ''
                basic.gender = detail.gender ?? ''
                basic.birthYear = detail.birth?.year ?? null
                basic.birthMon = detail.birth?.mon ?? null
                basic.birthDay = detail.birth?.day ?? null
              } catch {
                // 详情拿不到就用列表数据
              }
            }
            allChars.push(basic)
          }
        }
      } catch {
        // 角色 API 不可用，跳过
      }
      console.log(`    角色: ${allChars.length} 个`)

      // 2c. 短评 → HTML（非 R18 公开可访问）
      const allComments: CrawlResult['comments'] = []
      for (let p = 1; p <= 3; p++) {
        try {
          const { url: cUrl, cacheKey: cKey } = commentsUrl(game.id, p)
          const cHtml = await fetchHTML(cUrl, cKey)
          const comments = parseComments(cHtml)
          allComments.push(...comments)
        } catch {
          break
        }
      }
      console.log(`    短评: ${allComments.length} 条`)

      // 2d. 长评 → HTML
      let allReviews: CrawlResult['reviews'] = []
      try {
        const { url: rUrl, cacheKey: rKey } = reviewsUrl(game.id)
        const rHtml = await fetchHTML(rUrl, rKey)
        allReviews = parseReviews(rHtml)
      } catch {
        // 没有长评
      }
      console.log(`    长评: ${allReviews.length} 篇`)

      // 保存结果（按类型分目录）
      const result: CrawlResult = { game: detail, comments: allComments, reviews: allReviews, characters: allChars }
      results.push(result)
      await saveJSON('games', `${game.id}.json`, detail)
      await saveJSON('comments', `${game.id}.json`, allComments)
      await saveJSON('reviews', `${game.id}.json`, allReviews)
      await saveJSON('characters', `${game.id}.json`, allChars)

      if ((i + 1) % 10 === 0) {
        console.log(`  --- 已完成 ${i + 1}/${filtered.length} ---`)
      }
    } catch (err) {
      const reason = (err as Error).message || String(err)
      console.error(`  [失败] ${game.name}: ${reason}`)
      failedGames.push({ id: game.id, name: game.name, reason })
    }
  }

  // ── 保存失败列表 ──
  if (failedGames.length > 0) {
    await saveJSON('', 'failed-games.json', failedGames)
  }

  // ── 汇总 ──
  console.log('\n=== 爬取完成 ===')
  console.log(`总游戏数: ${results.length}`)
  console.log(`失败数: ${failedGames.length}`)
  const totalComments = results.reduce((s, r) => s + r.comments.length, 0)
  const totalReviews = results.reduce((s, r) => s + r.reviews.length, 0)
  const totalChars = results.reduce((s, r) => s + r.characters.length, 0)
  console.log(`总短评数: ${totalComments}`)
  console.log(`总长评数: ${totalReviews}`)
  console.log(`总角色数: ${totalChars}`)
  console.log(`\n数据已保存到 scripts/data/parsed/`)
  console.log(`失败记录已保存到 scripts/data/parsed/failed-games.json`)
}

main().catch(console.error)
