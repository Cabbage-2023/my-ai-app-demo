import puppeteer from 'puppeteer'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ENDPOINT_PATH = path.resolve('scripts/data/browser-endpoint.txt')

/** 连接正在运行的浏览器，抓取页面 HTML（用于 R18 内容） */
export async function fetchHTMLviaBrowser(url: string): Promise<string> {
  if (!existsSync(ENDPOINT_PATH)) {
    throw new Error('找不到 browser-endpoint.txt，请先运行 cookie-refresher.ts')
  }
  const wsEndpoint = await readFile(ENDPOINT_PATH, 'utf-8')

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint.trim(),
    defaultViewport: null,
  })

  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // 检测 404 页面
    const bodyText = await page.evaluate(() => document.body.innerText)
    if (bodyText.includes('呜咕，出错了') || bodyText.includes('数据库中没有查询')) {
      throw new Error(`404: ${url}`)
    }

    const html = await page.content()
    return html
  } finally {
    await page.close()
  }
}
