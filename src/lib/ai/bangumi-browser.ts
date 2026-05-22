/**
 * 服务端 Puppeteer 浏览器连接管理
 *
 * R18 抓取策略：
 *   1. 连接已运行的持久浏览器（cookie-refresher.ts 启动的 Edge）
 *   2. 连接后验证 R18 权限：打开测试页检查是否被"呜咕"拦截
 *   3. 如果 R18 权限不足 → 断开连接、删除旧端点文件、重新启动 cookie-refresher
 *   4. 如果没在跑，自动启动 cookie-refresher.ts
 *      → 已登录则秒过，未登录则等待用户在浏览器中登录
 *      → cookie-refresher 会保持运行，后续请求直接复用
 */

import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ENDPOINT_PATH = path.resolve('scripts/data/browser-endpoint.txt');
const PROJECT_ROOT = path.resolve('.');

/** 用于验证 R18 权限的测试页面（一个已知 R18 条目） */
const R18_TEST_URL = 'https://bgm.tv/subject/226254';

let _browser: Browser | null = null;
let _launching = false;

/** 验证浏览器是否有 R18 访问权限 */
async function checkR18Access(browser: Browser): Promise<boolean> {
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.goto(R18_TEST_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    return !text.includes('呜咕');
  } catch {
    return false;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** 启动 cookie-refresher.ts（已登录则自动通过，未登录则等待用户） */
async function launchBrowserProcess(): Promise<void> {
  if (_launching) {
    // 已经在启动中，等待端点文件出现
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (existsSync(ENDPOINT_PATH)) return;
    }
    throw new Error('启动 cookie-refresher 超时（60 秒）');
  }

  _launching = true;
  console.log('[browser] 启动 cookie-refresher.ts...');

  const child = spawn('pnpm', ['tsx', 'scripts/crawl/cookie-refresher.ts'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: true,
    detached: false,
  });

  child.on('error', (err) => {
    console.error('[browser] 启动 cookie-refresher 失败:', err.message);
    _launching = false;
  });

  child.on('exit', (code) => {
    console.log(`[browser] cookie-refresher 退出 (code=${code})`);
    _launching = false;
  });

  // 等待 browser-endpoint.txt 出现（cookie-refresher 启动后写入）
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (existsSync(ENDPOINT_PATH)) {
      console.log('[browser] cookie-refresher 就绪');
      _launching = false; // 启动完成，允许未来重新启动
      return;
    }
  }

  throw new Error('等待 cookie-refresher 启动超时（120 秒）');
}

/** 连接或复用浏览器（始终返回有 R18 权限的浏览器） */
async function getBrowser(): Promise<Browser> {
  // 已有连接 → 验证 R18（避免 session 过期未被发现）
  if (_browser?.connected) {
    if (await checkR18Access(_browser)) {
      return _browser;
    }
    console.log('[browser] 浏览器 R18 权限已过期，断开连接并重新启动');
    await _browser.disconnect();
    _browser = null;
    await rm(ENDPOINT_PATH, { force: true });
    _launching = false;
  }

  // 端点文件存在 → 尝试连接持久浏览器
  if (existsSync(ENDPOINT_PATH)) {
    const wsEndpoint = (await readFile(ENDPOINT_PATH, 'utf-8')).trim();
    try {
      _browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
      if (await checkR18Access(_browser)) {
        return _browser;
      }
      console.log('[browser] 持久浏览器 R18 权限不足，重新启动 cookie-refresher');
      await _browser.disconnect();
      _browser = null;
      await rm(ENDPOINT_PATH, { force: true });
      _launching = false;
    } catch (err) {
      console.log('[browser] 连接持久浏览器失败，启动临时无头浏览器');
      _browser = null;
      await rm(ENDPOINT_PATH, { force: true });
      _launching = false;
    }
  }

  // 启动 cookie-refresher（会等待用户登录 + R18 授权）
  await launchBrowserProcess();

  // 连接新启动的浏览器
  const wsEndpoint = (await readFile(ENDPOINT_PATH, 'utf-8')).trim();
  _browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  return _browser;
}

/** 通过浏览器获取页面 HTML（用于 R18 内容） */
export async function fetchHTMLviaBrowser(url: string): Promise<string> {
  if (!isBrowserAvailable()) {
    throw new Error('服务器无浏览器环境，不支持 R18 页面回填。请在本地开发环境执行回填，或使用 Bangumi API（普通内容不受影响）。');
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const bodyText = await page.evaluate(() => document.body.innerText);
    if (bodyText.includes('呜咕，出错了') || bodyText.includes('数据库中没有查询')) {
      throw new Error(`404: ${url}`);
    }

    return await page.content();
  } finally {
    await page.close();
  }
}

/** 检测本地是否有 Puppeteer 浏览器可用 */
function isBrowserAvailable(): boolean {
  // 未安装 puppeteer → 无浏览器
  try {
    puppeteer.executablePath();
    return true;
  } catch {
    return false;
  }
}

/** 断开浏览器连接 */
export async function disconnectBrowser(): Promise<void> {
  if (_browser?.connected) {
    await _browser.disconnect();
    _browser = null;
  }
}
