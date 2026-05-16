import * as cheerio from 'cheerio'
import type { CharacterInfo } from './types'

/** 从 API 响应解析角色详情 */
export function parseCharacterDetailFromAPI(
  id: number,
  data: any,
  subjectId: number,
): CharacterInfo {
  const name = data.name ?? ''
  const nameCN = data.name_cn ?? ''

  const summary = (data.summary ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()

  const gender = data.gender ?? ''
  const birthYear = data.birth?.year ?? null
  const birthMon = data.birth?.mon ?? null
  const birthDay = data.birth?.day ?? null
  const imageUrl = data.images?.medium ?? data.images?.large ?? ''

  let cvName = ''
  if (data.actors && data.actors.length > 0) {
    cvName = data.actors[0].name ?? ''
  }

  return {
    id, name, nameCN, summary, gender,
    birthYear, birthMon, birthDay, imageUrl, cvName, subjectId,
  }
}

export function parseCharacterDetail(
  id: number,
  html: string,
  subjectId: number,
): CharacterInfo {
  const $ = cheerio.load(html)

  const name = $('h1.nameSingle a').first().text().trim()
  const nameCN = $('h1.nameSingle small.grey').first().text().trim()

  const summary = $('.detail').text().trim()

  // 基本信息
  let gender = ''
  let birthYear: number | null = null
  let birthMon: number | null = null
  let birthDay: number | null = null

  $('#infobox li').each((_, el) => {
    const text = $(el).text()
    if (text.includes('性别')) {
      gender = text.replace('性别: ', '').trim()
    }
    if (text.includes('生日')) {
      const birthText = text.replace('生日: ', '').trim()
      // 格式: "1989年5月28日" 或 "12月24日"
      const y = birthText.match(/(\d{4})年/)
      const m = birthText.match(/(\d{1,2})月/)
      const d = birthText.match(/(\d{1,2})日/)
      if (y) birthYear = parseInt(y[1], 10)
      if (m) birthMon = parseInt(m[1], 10)
      if (d) birthDay = parseInt(d[1], 10)
    }
  })

  // 头像
  const imageUrl = $('.infobox .cover').attr('src') ?? ''

  // CV（从出演列表第一项取）
  let cvName = ''
  $('.badge_actor').first().each((_, el) => {
    cvName = $(el).find('a.l').last().text().trim()
  })

  return {
    id,
    name,
    nameCN,
    summary,
    gender,
    birthYear,
    birthMon,
    birthDay,
    imageUrl,
    cvName,
    subjectId,
  }
}
