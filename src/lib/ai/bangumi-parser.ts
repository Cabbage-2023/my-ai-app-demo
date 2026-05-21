/**
 * Bangumi HTML 页面解析器
 *
 * 从 Bangumi HTML 页面中提取结构化数据。
 * 逻辑与 `scripts/lib/crawl/parsers/` 完全一致。
 */
import * as cheerio from 'cheerio';

export interface ParsedComment {
  userId: string;
  userName: string;
  text: string;
  score: number;
  status: string;
  date: string;
}

export interface ParsedReview {
  id: number;
  title: string;
  summary: string;
  fullContent: string;
  author: string;
  replyCount: number;
  date: string;
}

export interface ParsedCharComment {
  floor: number;
  userId: string;
  userName: string;
  text: string;
  date: string;
}

/** 解析短评页面 HTML */
export function parseComments(html: string): ParsedComment[] {
  const $ = cheerio.load(html);
  const result: ParsedComment[] = [];

  $('.item.clearit').each((_, el) => {
    const $el = $(el);
    const userName = $el.find('a.l').first().text().trim();
    const userHref = $el.find('a.l').first().attr('href') ?? '';
    const userId = userHref.replace('/user/', '');
    const text = $el.find('p.comment').text().trim();
    if (!text || text === '删除了回复') return;

    const starClass = $el.find('.starstop-s .starlight').attr('class') ?? '';
    const match = starClass.match(/stars(\d+)/);
    const score = match ? parseInt(match[1], 10) : 0;

    const status = $el.find('small.grey').first().text().trim();
    const date = $el.find('small.grey').last().text().trim().replace('@ ', '');

    result.push({ userId, userName, text, score, status, date });
  });

  return result;
}

/** 解析长评列表页 HTML */
export function parseReviews(html: string): ParsedReview[] {
  const $ = cheerio.load(html);
  const result: ParsedReview[] = [];

  $('.entry-list .item').each((_, el) => {
    const $el = $(el);
    const href = $el.find('h2.title a').attr('href') ?? '';
    const id = parseInt(href.replace('/blog/', ''), 10);
    if (isNaN(id)) return;

    const title = $el.find('h2.title a').text().trim();
    const summary = $el.find('.content').text().trim();
    const author = $el.find('.tools a.l').text().trim();

    const toolsText = $el.find('.tools .time').text().trim();
    const replyMatch = toolsText.match(/(\d+)\s*回复/);
    const replyCount = replyMatch ? parseInt(replyMatch[1], 10) : 0;
    const dateMatch = toolsText.match(/(\d{4}.\d{1,2}.\d{1,2}\s*\d{1,2}:\d{2})/);
    const date = dateMatch ? dateMatch[1] : '';

    if (!title && !summary) return;
    result.push({ id, title, summary, fullContent: '', author, replyCount, date });
  });

  return result;
}

/** 解析长评全文页面 HTML（/blog/{id}） */
export function parseBlogContent(html: string): string {
  const $ = cheerio.load(html);
  const $content = $('#entry_content');
  if ($content.length === 0) return '';

  $content.find('img').remove();
  return $content.text()
    .replace(/&nbsp;/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解析角色吐槽页面 HTML */
export function parseCharComments(html: string): ParsedCharComment[] {
  const $ = cheerio.load(html);
  const result: ParsedCharComment[] = [];

  $('#comment_list .row_reply').each((_, el) => {
    const $el = $(el);
    const anchorText = $el.find('.floor-anchor').text().trim();
    const floorMatch = anchorText.match(/#(\d+)/);
    const floor = floorMatch ? parseInt(floorMatch[1], 10) : 0;
    const date = anchorText.replace(/^#\d+\s*-\s*/, '').trim();

    const userName = $el.find('strong a.l').first().text().trim();
    const userHref = $el.find('strong a.l').first().attr('href') ?? '';
    const userId = userHref.replace('/user/', '');

    const $message = $el.find('.message.clearit');
    let text = '';
    const $maskInner = $message.find('.text_mask .inner');
    if ($maskInner.length > 0) {
      text = $maskInner.text().trim();
    } else {
      text = $message.clone().children().remove().end().text().trim();
      if (!text) text = $message.text().trim();
    }
    if (!text || text === '删除了回复') return;

    result.push({ floor, userId, userName, text, date });
  });

  return result;
}
