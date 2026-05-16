import puppeteer from 'puppeteer'
import path from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { saveCookies, getCookiePath } from './lib/cookie-manager'

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const USER_DATA_DIR = path.resolve('scripts/data/puppeteer-profile')

async function main() {
  console.log('=== Bangumi Cookie 刷新器 ===\n')

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: EDGE_PATH,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--remote-debugging-port=9222'],
  })
  // 保存调试端口信息，供爬虫连接
  // 保存浏览器调试端点到单独文件
  const wsEndpoint = browser.wsEndpoint()
  await mkdir(path.dirname(getCookiePath()), { recursive: true })
  await writeFile(path.resolve('scripts/data/browser-endpoint.txt'), wsEndpoint, 'utf-8')

  // 关闭所有恢复的标签页，新建一个干净的
  for (const p of await browser.pages()) await p.close().catch(() => {})
  const page = await browser.newPage()
  await page.goto('https://bangumi.tv', { waitUntil: 'networkidle2', timeout: 30000 })

  // 检查是否已登录（看页面有没有"我的主页"或用户名）
  const bodyText = await page.evaluate(() => document.body.innerText)
  const isLoggedIn = /\d{4,9}/.test(bodyText) // 用户ID通常是一串数字

  if (!isLoggedIn) {
    console.log('未检测到登录状态。请在浏览器中登录 Bangumi（输入账号+密码+验证码）')
    console.log('登录完成后，回到此终端按 Enter 继续...')
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve())
    })
    // 等页面跳转完成
    await new Promise((r) => setTimeout(r, 2000))
  }

  console.log('登录状态确认中...')
  await page.goto('https://bangumi.tv', { waitUntil: 'networkidle2' })

  // 验证 R18 访问权限：打开一个 R18 游戏详情页
  console.log('验证 R18 访问权限...')
  await page.goto('https://bangumi.tv/subject/226254', { waitUntil: 'networkidle2' })
  const r18Text = await page.evaluate(() => document.body.innerText)
  const hasR18Access = !r18Text.includes('呜咕，出错了') && r18Text.includes('兰斯')

  if (!hasR18Access) {
    console.log('\n⚠️  当前登录状态无法访问 R18 内容。')
    console.log('请在浏览器中手动打开一个 R18 页面（如 https://bangumi.tv/subject/518278）')
    console.log('如果提示登录，请用你的账号登录。')
    console.log('我会每 5 秒检查一次，直到检测到 R18 访问权限...\n')

    // 轮询等待 R18 权限就绪
    let r18Ready = false
    for (let attempt = 1; attempt <= 60; attempt++) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        await page.goto('https://bangumi.tv/subject/226254', { waitUntil: 'domcontentloaded', timeout: 10000 })
        const checkText = await page.evaluate(() => document.body.innerText)
        if (!checkText.includes('呜咕，出错了') && (checkText.includes('兰斯') || checkText.includes('ランス'))) {
          r18Ready = true
          console.log('  ✅ R18 访问已就绪！')
          break
        }
        console.log(`  [第 ${attempt} 次检查] 仍未就绪，等待中...`)
      } catch {
        console.log(`  [第 ${attempt} 次检查] 页面加载异常，重试中...`)
      }
    }
    if (!r18Ready) {
      console.log('\n❌ 等待超时（5分钟），未能检测到 R18 访问权限。')
      console.log('请确认：1. 已登录正确账号 2. 浏览器中能正常打开 R18 页面')
      console.log('完成后重新运行本脚本。')
    }
  }

  // 提取 cookie
  const cookies = await page.cookies()
  await saveCookies(cookies)

  const chiiSid = cookies.find((c) => c.name === 'chii_sid')
  console.log(`\n✅ Cookie 已保存到 ${getCookiePath()}`)
  console.log(`   共 ${cookies.length} 个 cookie`)
  if (chiiSid) console.log(`   chii_sid: ${chiiSid.value.substring(0, 8)}...`)
  console.log(`   R18 访问: ${hasR18Access ? '正常' : '失败，请检查账号设置'}`)

  // 浏览器保持打开，每 30 秒刷新 cookie
  console.log('\n浏览器保持打开中，自动刷新 cookie...')
  console.log('你可以最小化浏览器窗口，不要关闭它。')
  console.log('现在可以另开终端运行爬虫：pnpm tsx scripts/crawler.ts')
  console.log('按 Ctrl+C 停止刷新器\n')

  let tick = 0
  setInterval(async () => {
    let freshPage: puppeteer.Page | null = null
    try {
      freshPage = await browser.newPage()
      await freshPage.goto('https://bangumi.tv', { waitUntil: 'domcontentloaded', timeout: 15000 })
      const fresh = await freshPage.cookies()
      await saveCookies(fresh)
      tick++
      const chii = fresh.find((c) => c.name === 'chii_sid')
      console.log(
        `  [${new Date().toLocaleTimeString()}] 第 ${tick} 次刷新` +
          (chii ? ` | chii_sid: ${chii.value.substring(0, 8)}...` : ''),
      )
    } catch (e) {
      console.error('  刷新失败:', (e as Error).message)
    } finally {
      if (freshPage) await freshPage.close().catch(() => {})
    }
  }, 30000)

  // 保持进程运行
  await new Promise(() => {})
}

main().catch(console.error)
