import * as cheerio from 'cheerio'
import type { GameListItem } from './types'

export function parseGameList(html: string): GameListItem[] {
  const $ = cheerio.load(html)
  const items: GameListItem[] = []

  $('#browserItemList li.item').each((_, el) => {
    const $el = $(el)

    const link = $el.find('h3 a.l').first()
    const href = link.attr('href') ?? ''
    const id = parseInt(href.replace('/subject/', ''), 10)
    if (isNaN(id)) return

    const name = link.text().trim()
    const nameJP = $el.find('h3 small.grey').text().trim()

    const rankText = $el.find('.rank').text().trim()
    const rank = parseInt(rankText.replace('Rank ', ''), 10)

    const scoreText = $el.find('.rateInfo small.fade').text().trim()
    const score = parseFloat(scoreText) || 0

    const ratingInfo = $el.find('.rateInfo .tip_j').text()
    const ratingMatch = ratingInfo.match(/\((\d+)人评分\)/)
    const ratingCount = ratingMatch ? parseInt(ratingMatch[1], 10) : 0

    const coverUrl = $el.find('.subjectCover img').attr('src') ?? ''

    items.push({ id, name, nameJP, rank, score, ratingCount, coverUrl })
  })

  return items
}
