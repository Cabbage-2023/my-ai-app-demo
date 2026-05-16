/** HTML 标签 → 纯文本 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

/** 判断文本是否有意义（过滤纯 emoji、过短内容） */
export function isNoise(text: string): boolean {
  const cleaned = text.trim()
  if (cleaned.length < 5) return true
  // 纯 emoji / 纯符号
  if (/^[\p{Emoji}\s]+$/u.test(cleaned)) return true
  // 纯标点
  if (/^[。，！？、…·～\-—\s]+$/.test(cleaned)) return true
  return false
}

/** 清洗一条评论 */
export function cleanComment(text: string): string {
  return stripHtml(text)
}
