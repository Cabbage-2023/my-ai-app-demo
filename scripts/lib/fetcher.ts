import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { COOKIE_STRING, BANGUMI_API_TOKEN, BASE_URL, API_BASE_URL, REQUEST_DELAY_MS, MAX_RETRIES } from './config'
import { readCookieString } from './cookie-manager'

const dataDir = path.resolve('scripts/data/raw')

/** 读取 cookie（优先用浏览器实时 cookie 文件，无则用 .env 配置） */
async function resolveCookie(): Promise<string> {
  const fileCookie = await readCookieString()
  return fileCookie || COOKIE_STRING
}

/** 读取或下载 HTML，带缓存 */
export async function fetchHTML(
  url: string,
  cacheKey?: string,
  options?: { noCookie?: boolean },
): Promise<string> {
  const cachePath = cacheKey ? path.join(dataDir, `${cacheKey}.html`) : null

  // 缓存命中则直接返回
  if (cachePath && existsSync(cachePath)) {
    return await readFile(cachePath, 'utf-8')
  }

  // 限速：每次请求前等 1 秒
  await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS))

  const cookie = options?.noCookie ? '' : await resolveCookie()
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
      if (cookie) headers['Cookie'] = cookie

      const res = await fetch(url, { headers })

      const text = await res.text()

      // 检测 404 页面（bangumi 返回 200 但内容是 404 模板）
      // 404 不重试，直接抛给调用方去用 API 兜底
      if (text.includes('呜咕，出错了') || text.includes('数据库中没有查询')) {
        throw new Error(`404: ${url}`)
      }

      // 写入缓存
      if (cachePath) {
        await mkdir(path.dirname(cachePath), { recursive: true })
        await writeFile(cachePath, text, 'utf-8')
      }

      return text
    } catch (err) {
      // 404 不重试，直接失败
      if ((err as Error).message.startsWith('404:')) throw err
      lastErr = err as Error
      if (attempt < MAX_RETRIES) {
        console.warn(`[retry ${attempt}/${MAX_RETRIES}] ${url}`)
        await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
    }
  }

  throw lastErr
}

/** 生成排行榜页的 URL 和 cacheKey */
export function rankUrl(page: number) {
  return {
    url: `${BASE_URL}/game/tag/Galgame/?sort=rank&page=${page}`,
    cacheKey: `rank-page-${page}`,
  }
}

/** 生成游戏详情页的 URL 和 cacheKey */
export function gameUrl(id: number) {
  return {
    url: `${BASE_URL}/subject/${id}`,
    cacheKey: `game-${id}`,
  }
}

/** 生成评论页的 URL 和 cacheKey */
export function commentsUrl(id: number, page: number) {
  return {
    url: `${BASE_URL}/subject/${id}/comments?page=${page}`,
    cacheKey: `comments-${id}-p${page}`,
  }
}

/** 生成长评页的 URL 和 cacheKey */
export function reviewsUrl(id: number) {
  return {
    url: `${BASE_URL}/subject/${id}/reviews`,
    cacheKey: `reviews-${id}`,
  }
}

/** 生成角色评论页的 URL 和 cacheKey */
export function charCommentsUrl(id: number) {
  return {
    url: `${BASE_URL}/character/${id}`,
    cacheKey: `char-comments-${id}`,
  }
}

/** 生成 blog（长评全文）页的 URL 和 cacheKey */
export function blogUrl(id: number) {
  return {
    url: `${BASE_URL}/blog/${id}`,
    cacheKey: `blog-${id}`,
  }
}

/** 生成角色详情页的 URL 和 cacheKey */
export function characterUrl(id: number) {
  return {
    url: `${BASE_URL}/character/${id}`,
    cacheKey: `character-${id}`,
  }
}

/** 调用 Bangumi API（带 Bearer Token，可以访问所有内容） */
export async function fetchAPI(endpoint: string): Promise<any> {
  await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS))

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  }
  if (BANGUMI_API_TOKEN) {
    headers['Authorization'] = `Bearer ${BANGUMI_API_TOKEN}`
  }

  const res = await fetch(`${API_BASE_URL}${endpoint}`, { headers })
  if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`)
  return res.json()
}
