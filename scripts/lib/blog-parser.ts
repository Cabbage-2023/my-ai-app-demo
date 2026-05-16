import * as cheerio from 'cheerio'

/**
 * 解析 blog 长评页面，提取正文纯文本。
 * 容器：`#entry_content`
 * HTML 中包含 `<br>`、`&nbsp;`、`<span>`、`<img>`（表情）等。
 */
export function parseBlogContent(html: string): string {
  const $ = cheerio.load(html)
  const $content = $('#entry_content')
  if ($content.length === 0) return ''

  // 去掉表情图片，提取纯文本
  $content.find('img').remove()
  let text = $content.text()

  // 清理空白
  text = text
    .replace(/ /g, ' ')   // &nbsp; → 空格
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}
