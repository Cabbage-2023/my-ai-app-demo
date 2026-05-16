import * as cheerio from 'cheerio'
import type { GameDetail } from './types'

export function parseGameDetail(id: number, html: string): GameDetail {
  const $ = cheerio.load(html)

  const name = $('h1.nameSingle a').first().text().trim()
  const nameCN = $('h1.nameSingle small.grey').first().text().trim()

  // 剧情简介
  const summary = $('#subject_summary').text().trim()

  // 信息表
  const infobox: { key: string; value: string }[] = []
  $('#infobox li').each((_, el) => {
    const $el = $(el)
    const key = $el.find('.tip').first().text().replace(':', '').trim()
    if (!key) return
    // 值可能是文本或链接
    const value = $el.clone().children('.tip').remove().end().text().trim()
    infobox.push({ key, value })
  })

  // 标签
  const tags: string[] = []
  $('.subject_tag_section .inner a').each((_, el) => {
    const tag = $(el).find('span').first().text().trim()
    if (tag) tags.push(tag)
  })

  // 评分
  const scoreText = $('.global_score .number').text().trim()
  const score = parseFloat(scoreText) || 0

  // 排名
  const rankText = $('.global_rating .description').text().trim()
  // 排名在后面的灰色小字里: "Bangumi Game Ranked:#12"
  const rankEl = $('.global_rating .alarm').text().trim()
  const rank = parseInt(rankEl.replace('#', ''), 10) || 0

  // 评分人数
  const votesText = $('.chart_desc span').text().trim()
  const votesMatch = votesText.match(/(\d+)\s*votes/)
  const ratingCount = votesMatch ? parseInt(votesMatch[1], 10) : 0

  // 封面图
  const coverUrl = $('.infobox .thickbox img').attr('src') ?? ''

  // NSFW 检测：看标签里有没有 R18
  const nsfw = tags.some((t) => t === 'R18')

  return {
    id,
    name,
    nameCN,
    summary,
    infobox,
    tags,
    score,
    rank,
    ratingCount,
    coverUrl,
    nsfw,
  }
}

/** 从游戏详情页提取角色 ID 列表 */
export function extractCharacterIds(html: string): number[] {
  const $ = cheerio.load(html)
  const ids: number[] = []

  $('.crtList a.thumbTip').each((_, el) => {
    const href = $(el).attr('href') ?? ''
    const id = parseInt(href.replace('/character/', ''), 10)
    if (!isNaN(id)) ids.push(id)
  })

  return [...new Set(ids)] // 去重
}

/** 从 API 响应解析游戏简介（HTML 404 时兜底用） */
export function parseGameDetailFromAPI(id: number, data: any): GameDetail {
  const tags = (data.tags ?? []).map((t: any) => t.name)
  const infobox = (data.infobox ?? []).map((i: any) => ({
    key: i.key,
    value: typeof i.value === 'string' ? i.value : JSON.stringify(i.value),
  }))

  return {
    id,
    name: data.name ?? '',
    nameCN: data.name_cn ?? '',
    summary: data.summary ?? '',
    infobox,
    tags,
    score: data.rating?.score ?? 0,
    rank: data.rating?.rank ?? 0,
    ratingCount: data.rating?.total ?? 0,
    coverUrl: data.images?.common ?? '',
    nsfw: data.nsfw ?? false,
  }
}
