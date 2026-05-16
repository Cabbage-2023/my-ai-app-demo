import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const COOKIE_PATH = path.resolve('scripts/data/cookies.json')

/** 读取保存的 cookie，返回 cookie 字符串（如 "a=1; b=2"） */
export async function readCookieString(): Promise<string | null> {
  try {
    if (!existsSync(COOKIE_PATH)) return null
    const raw = await readFile(COOKIE_PATH, 'utf-8')
    const cookies = JSON.parse(raw)
    if (!Array.isArray(cookies) || cookies.length === 0) return null

    // 只保留 bangumi.tv 的 cookie，拼接成 header 格式
    const valid = cookies.filter(
      (c: any) => c.domain?.includes('bangumi') || c.domain?.includes('bgm'),
    ) as { name: string; value: string }[]
    if (valid.length === 0) return null

    return valid.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return null
  }
}

/** 保存 cookie 数组到文件 */
export async function saveCookies(cookies: { name: string; value: string; domain?: string }[]) {
  await mkdir(path.dirname(COOKIE_PATH), { recursive: true })
  await writeFile(COOKIE_PATH, JSON.stringify(cookies, null, 2))
}

/** 获取 cookie 文件路径（给 refresher 检查用） */
export function getCookiePath() {
  return COOKIE_PATH
}
