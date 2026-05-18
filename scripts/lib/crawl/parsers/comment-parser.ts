import * as cheerio from 'cheerio'
import type { Comment, Review } from '../types'

/** 星星 class → 分数 (1-10) */
function starClassToScore(className: string): number {
  const match = className.match(/stars(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

export function parseComments(html: string): Comment[] {
  const $ = cheerio.load(html)
  const comments: Comment[] = []

  $('.item.clearit').each((_, el) => {
    const $el = $(el)

    const userName = $el.find('a.l').first().text().trim()
    const userHref = $el.find('a.l').first().attr('href') ?? ''
    const userId = userHref.replace('/user/', '')

    const text = $el.find('p.comment').text().trim()
    if (!text) return

    const starClass =
      $el.find('.starstop-s .starlight').attr('class') ?? ''
    const score = starClassToScore(starClass)

    const status = $el.find('small.grey').first().text().trim()

    const dateText = $el.find('small.grey').last().text().trim()
    const date = dateText.replace('@ ', '')

    comments.push({ userId, userName, text, score, status, date })
  })

  return comments
}

export function parseReviews(html: string): Review[] {
  const $ = cheerio.load(html)
  const reviews: Review[] = []

  $('.entry-list .item').each((_, el) => {
    const $el = $(el)

    const href = $el.find('h2.title a').attr('href') ?? ''
    const id = parseInt(href.replace('/blog/', ''), 10)
    if (isNaN(id)) return

    const title = $el.find('h2.title a').text().trim()
    const summary = $el.find('.content').text().trim()
    const author = $el.find('.tools a.l').text().trim()

    const replyText = $el.find('.tools .time').text().trim()
    const replyMatch = replyText.match(/(\d+)\s*回复/)
    const replyCount = replyMatch ? parseInt(replyMatch[1], 10) : 0

    const dateText = $el.find('.tools .time').text().trim()
    // 日期在 author 和回复数之间，格式 "2025-10-4 17:23"
    const dateMatch = dateText.match(/(\d{4}.\d{1,2}.\d{1,2}\s*\d{1,2}:\d{2})/)
    const date = dateMatch ? dateMatch[1] : ''

    reviews.push({ id, title, summary, author, replyCount, date })
  })

  return reviews
}
