import * as cheerio from 'cheerio'

export interface CharComment {
  floor: number
  userId: string
  userName: string
  text: string
  date: string
}

export function parseCharComments(html: string): CharComment[] {
  const $ = cheerio.load(html)
  const comments: CharComment[] = []

  $('#comment_list .row_reply').each((_, el) => {
    const $el = $(el)

    // 楼层 & 日期
    const anchorText = $el.find('.floor-anchor').text().trim()
    const floorMatch = anchorText.match(/#(\d+)/)
    const floor = floorMatch ? parseInt(floorMatch[1], 10) : 0

    const date = anchorText.replace(/^#\d+\s*-\s*/, '').trim()

    // 用户名
    const userName = $el.find('strong a.l').first().text().trim()
    const userHref = $el.find('strong a.l').first().attr('href') ?? ''
    const userId = userHref.replace('/user/', '')

    // 评论内容 - 可能有剧透屏蔽 (.text_mask)，也可能直接平铺
    const $message = $el.find('.message.clearit')
    // 尝试取 .text_mask .inner（剧透内容），没有则直接取整个 message 的文本
    let text = ''
    const $maskInner = $message.find('.text_mask .inner')
    if ($maskInner.length > 0) {
      text = $maskInner.text().trim()
    } else {
      text = $message.clone().children().remove().end().text().trim()
      // 如果去掉子元素后为空，说明只有 text_mask 一层包裹
      if (!text) {
        text = $message.text().trim()
      }
    }

    if (!text) return
    if (text === '删除了回复' || text.includes('删除了回复')) return

    comments.push({ floor, userId, userName, text, date })
  })

  return comments
}
