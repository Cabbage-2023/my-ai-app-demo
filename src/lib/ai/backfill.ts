/**
 * 知识库自动扩展（Backfill）
 *
 * 完整管道：质量门禁 → API 数据 → HTML 抓取（fetch + 浏览器 fallback）
 *   → cheerio 解析 → 保存 parsed JSON → 分块 → 嵌入 → 写入 Qdrant
 *
 * 数据清洗标准和保存格式与 `scripts/etl/process.ts` 完全一致。
 * R18 页面通过 Puppeteer CDP 浏览器 fallback 获取。
 */

import * as cheerio from 'cheerio';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateEmbedding } from '@/lib/ai/embedding';
import { generateSparseEmbedding } from '@/lib/ai/sparse-embedding';
import {
  ensureResourceCollection,
  upsertBatch,
  scrollByFilter,
  nextPointId,
  type QdrantBatchPoint,
} from '@/lib/qdrant';
import { fetchHTMLviaBrowser, disconnectBrowser } from '@/lib/ai/bangumi-browser';
import {
  parseComments,
  parseReviews,
  parseBlogContent,
  parseCharComments,
  type ParsedComment,
  type ParsedReview,
  type ParsedCharComment,
} from '@/lib/ai/bangumi-parser';

// ── 常量 ─────────────────────────────────────────────────

const API_BASE = 'https://api.bgm.tv';
const WEB_BASE = 'https://bgm.tv';
const PARSED_DIR = path.resolve('scripts/data/parsed');

/** 正在处理中的 backfill 任务，异步完成前阻止重复提交 */
const inFlightBackfills = new Set<number>();

// ── 类型 ─────────────────────────────────────────────────

interface BangumiSubject {
  id: number;
  name: string;
  name_cn?: string;
  summary: string;
  type: number;
}

interface BangumiCharacter {
  id: number;
  name: string;
  name_cn?: string;
  summary: string;
}

export interface BackfillResult {
  success: boolean;
  status: 'accepted' | 'rejected' | 'error';
  message: string;
  details?: {
    subjectName: string;
    subjectId: number;
    sources: {
      gameIntro: boolean;
      characters: number;
      comments: number;
      reviews: number;
      charComments: number;
    };
    chunksPersisted: number;
  };
}

// ── HTTP 客户端（与 scripts/lib/crawl/fetcher.ts 一致） ────

const REQUEST_DELAY_MS = 300;
const MAX_RETRIES = 3;

/** 调用 Bangumi API（带 Bearer Token，可以访问所有内容） */
async function fetchAPI(endpoint: string): Promise<any> {
  await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  const token = process.env.BANGUMI_API_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, { headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
  return res.json();
}

/** 从 cookies.json 读取 bangumi 网页 cookie（由 cookie-refresher 维护） */
async function readWebCookie(): Promise<string | null> {
  const cookiePath = path.resolve('scripts/data/cookies.json');
  try {
    if (!existsSync(cookiePath)) return null;
    const raw = await readFile(cookiePath, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    const valid = cookies.filter(
      (c: any) => c.domain?.includes('bangumi') || c.domain?.includes('bgm'),
    );
    if (valid.length === 0) return null;
    return valid.map((c: any) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

/** 与 scripts/lib/crawl/fetcher.ts 一致的 fetchHTML（带缓存/重试/浏览器 fallback） */
async function fetchHTML(pathname: string): Promise<string> {
  const url = `${WEB_BASE}${pathname}`;
  const cacheKey = pathname.replace(/[\/?&]/g, '-').replace(/^-+/, '');
  const cachePath = path.resolve('scripts/data/raw', `${cacheKey}.html`);

  // 缓存命中则直接返回
  if (existsSync(cachePath)) {
    return await readFile(cachePath, 'utf-8');
  }

  // 限速
  await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));

  // 优先读 cookies.json（cookie-refresher 维护），没有则用 .env 兜底
  let cookie = await readWebCookie();
  if (!cookie) {
    const parts: string[] = [];
    if (process.env.BANGUMI_COOKIE_SEC_ID)
      parts.push(`chii_sec_id=${encodeURIComponent(process.env.BANGUMI_COOKIE_SEC_ID)}`);
    if (process.env.BANGUMI_COOKIE_SID)
      parts.push(`chii_sid=${process.env.BANGUMI_COOKIE_SID}`);
    if (parts.length > 0) cookie = parts.join('; ');
  }

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (cookie) headers['Cookie'] = cookie;

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();

      // 检测 Bangumi 错误页（404 / R18 拦截），走浏览器 fallback
      if (text.includes('呜咕')) {
        break;
      }

      // 写入缓存
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, text, 'utf-8');

      return text;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === '404') throw e;

      lastErr = e as Error;
      if (attempt < MAX_RETRIES) {
        console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${pathname}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  // 全部重试失败 → 浏览器 fallback
  console.log(`    → 浏览器 fallback: ${pathname}`);
  try {
    return await fetchHTMLviaBrowser(url);
  } catch (err) {
    // 浏览器可能 R18 权限过期，断开并重试（会触发 getBrowser 重新验证 + 重启 refresher）
    console.log(`    → 浏览器 fallback 失败 (${(err as Error).message})，断开浏览器重试...`);
    await disconnectBrowser();
    await new Promise(r => setTimeout(r, 3000));
    return await fetchHTMLviaBrowser(url);
  }
}

// ── Phase 1: API 数据 ────────────────────────────────────

async function fetchSubjectAndCharacters(subjectId: number): Promise<{
  subject: BangumiSubject;
  characters: BangumiCharacter[];
}> {
  const [subject, characters] = await Promise.all([
    fetchAPI(`/v0/subjects/${subjectId}`) as Promise<BangumiSubject>,
    fetchAPI(`/v0/subjects/${subjectId}/characters`) as Promise<BangumiCharacter[]>,
  ]);
  return { subject, characters: Array.isArray(characters) ? characters : [] };
}

// ── Phase 2: HTML 抓取 ───────────────────────────────────

/** 抓取短评（前 3 页） */
async function scrapeComments(subjectId: number): Promise<ParsedComment[]> {
  const all: ParsedComment[] = [];
  for (let p = 1; p <= 3; p++) {
    try {
      const html = await fetchHTML(`/subject/${subjectId}/comments?page=${p}`);
      const page = parseComments(html);
      if (page.length === 0) break;
      all.push(...page);
    } catch {
      break;
    }
  }
  return all;
}

/** 抓取长评列表 + 逐篇补爬全文 */
async function scrapeReviews(subjectId: number): Promise<ParsedReview[]> {
  let list: ParsedReview[] = [];
  try {
    const html = await fetchHTML(`/subject/${subjectId}/reviews`);
    list = parseReviews(html);
  } catch {
    return [];
  }
  if (list.length === 0) return [];

  // 补爬全文（最多 3 篇，并行）
  const fulls = await Promise.all(
    list.slice(0, 3).map(async (r) => {
      try {
        const blogHtml = await fetchHTML(`/blog/${r.id}`);
        return parseBlogContent(blogHtml);
      } catch {
        return '';
      }
    }),
  );
  for (let i = 0; i < fulls.length; i++) {
    list[i].fullContent = fulls[i];
  }
  return list;
}

/** 抓取角色吐槽 */
async function scrapeCharComments(charId: number): Promise<ParsedCharComment[]> {
  try {
    const html = await fetchHTML(`/character/${charId}`);
    return parseCharComments(html);
  } catch {
    return [];
  }
}

// ── Phase 3: 保存 parsed JSON ───────────────────────────

interface SaveResult {
  comments: number;
  reviews: number;
  charComments: number;
}

async function saveParsedJSON(
  subjectId: number,
  gameName: string,
  comments: ParsedComment[],
  reviews: ParsedReview[],
  characters: BangumiCharacter[],
  charCommentLists: ParsedCharComment[][],
): Promise<SaveResult> {
  await mkdir(path.join(PARSED_DIR, 'comments'), { recursive: true });
  await mkdir(path.join(PARSED_DIR, 'reviews'), { recursive: true });
  await mkdir(path.join(PARSED_DIR, 'char-comments'), { recursive: true });

  if (comments.length > 0) {
    await writeFile(
      path.join(PARSED_DIR, 'comments', `${subjectId}.json`),
      JSON.stringify(comments, null, 2),
      'utf-8',
    );
  }
  if (reviews.length > 0) {
    await writeFile(
      path.join(PARSED_DIR, 'reviews', `${subjectId}.json`),
      JSON.stringify(reviews, null, 2),
      'utf-8',
    );
  }

  let savedCharComments = 0;
  for (let i = 0; i < characters.length; i++) {
    const cl = charCommentLists[i];
    if (cl && cl.length > 0) {
      await writeFile(
        path.join(PARSED_DIR, 'char-comments', `${characters[i].id}.json`),
        JSON.stringify(cl, null, 2),
        'utf-8',
      );
      savedCharComments += cl.length;
    }
  }

  return { comments: comments.length, reviews: reviews.length, charComments: savedCharComments };
}

// ── Phase 4: 分块 ────────────────────────────────────────

/** 中文递归分割器（与 process.ts 一致） */
function chunkText(text: string, maxSize = 500, overlap = 50): string[] {
  if (!text || text.length <= maxSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= maxSize) {
      chunks.push(text.slice(start));
      break;
    }
    const segment = text.slice(start, start + maxSize);
    let splitAt = -1;
    for (const sep of ['\n\n', '\n', '。', '！', '？', '，', '、', ' ']) {
      splitAt = segment.lastIndexOf(sep);
      if (splitAt >= 0) break;
    }
    if (splitAt < maxSize * 0.25) splitAt = maxSize;
    if (splitAt === maxSize) {
      const lastSpace = segment.lastIndexOf(' ', maxSize - 1);
      if (lastSpace > maxSize * 0.5) splitAt = lastSpace;
    }
    chunks.push(text.slice(start, start + splitAt + 1));
    start = start + splitAt + 1 - overlap;
    if (start >= text.length) break;
  }
  return chunks;
}

interface RawChunk {
  content: string;
  metadata: Record<string, any>;
  dedupKey: string;
}

function hashCode(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function chunkSubject(subject: BangumiSubject): RawChunk[] {
  const text = (subject.summary || '').trim();
  if (!text || text.length < 20) return [];
  return [{
    content: text,
    metadata: { type: 'game_intro', source: `game:${subject.id}`, gameName: subject.name_cn || subject.name || '' },
    dedupKey: `game_intro:game:${subject.id}`,
  }];
}

function chunkCharacters(characters: BangumiCharacter[], gameName: string): RawChunk[] {
  return characters
    .filter(c => (c.summary || '').trim().length >= 20)
    .map(c => ({
      content: c.summary.trim(),
      metadata: { type: 'character', source: `char:${c.id}`, gameName, charName: c.name_cn || c.name || '' },
      dedupKey: `character:char:${c.id}`,
    }));
}

function chunkComments(comments: ParsedComment[], gameName: string, subjectId: number): RawChunk[] {
  return comments
    .filter(c => c.text.trim().length >= 15)
    .map(c => ({
      content: c.text.trim(),
      metadata: { type: 'comment', source: `game:${subjectId}`, gameName },
      dedupKey: `comment:game:${subjectId}:${hashCode(c.text)}`,
    }));
}

function chunkReviews(reviews: ParsedReview[], gameName: string, subjectId: number): RawChunk[] {
  const result: RawChunk[] = [];
  for (const r of reviews) {
    const text = (r.fullContent || [r.title, r.summary].filter(Boolean).join('\n')).trim();
    if (!text || text.length < 20) continue;
    const subChunks = chunkText(text);
    for (let i = 0; i < subChunks.length; i++) {
      const sub = subChunks[i].trim();
      if (!sub || sub.length < 20) continue;
      result.push({
        content: sub,
        metadata: { type: 'review', source: `game:${subjectId}`, gameName, chunkIndex: i, totalChunks: subChunks.length },
        dedupKey: `review:game:${subjectId}:blog:${r.id}:chunk:${i}`,
      });
    }
  }
  return result;
}

function chunkCharComments(
  charComments: ParsedCharComment[],
  charName: string,
  charId: number,
): RawChunk[] {
  return charComments
    .filter(c => c.text.trim().length >= 15)
    .map(c => ({
      content: c.text.trim(),
      metadata: { type: 'char_review', source: `char:${charId}`, charName },
      dedupKey: `char_review:char:${charId}:${hashCode(c.text)}`,
    }));
}

// ── Phase 5: 持久化 ──────────────────────────────────────

async function persistChunks(chunks: RawChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;
  await ensureResourceCollection();

  const points: QdrantBatchPoint[] = [];
  for (const chunk of chunks) {
    const [dense, sparse] = await Promise.all([
      generateEmbedding(chunk.content),
      Promise.resolve(generateSparseEmbedding(chunk.content)),
    ]);
    points.push({
      id: nextPointId(),
      vector: dense,
      sparse_vectors: { bm25: sparse },
      payload: {
        content: chunk.content,
        dedupKey: chunk.dedupKey,
        ...chunk.metadata,
      },
    });
  }

  await upsertBatch(points);
  return points.length;
}

// ── 质量门禁 ─────────────────────────────────────────────

function qualityGate(subject: BangumiSubject): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (subject.type !== 4) reasons.push(`非游戏类型（type=${subject.type}）`);
  if ((subject.summary || '').trim().length < 20) {
    reasons.push(`简介过短（${(subject.summary || '').trim().length} 字）`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function checkDedup(subjectId: number): Promise<boolean> {
  const existing = await scrollByFilter(
    { must: [{ key: 'source', match: { value: `game:${subjectId}` } }] },
    1,
  );
  return existing.length > 0;
}

// ── 日志 ───────────────────────────────────────────────────

const LOG_PATH = path.resolve('logs/backfill.jsonl')

interface BackfillLogEntry {
  time: string
  subjectId: number
  name: string
  status: 'accepted' | 'rejected' | 'error'
  nsfw: boolean
  chunks: number
  comments: number
  reviews: number
  charComments: number
  errors: string[]
}

async function appendBackfillLog(entry: BackfillLogEntry): Promise<void> {
  try {
    await mkdir(path.dirname(LOG_PATH), { recursive: true })
    const line = JSON.stringify(entry) + '\n'
    // 用 append 模式写入（Node.js 18+ 支持 flag）
    const { appendFile } = await import('node:fs/promises')
    await appendFile(LOG_PATH, line, 'utf-8')
  } catch {
    // 日志写入失败不阻塞主流程
  }
}

// ── 主入口 ───────────────────────────────────────────────

export async function backfillBySubjectId(
  subjectId: number,
  name?: string,
): Promise<BackfillResult> {
  try {
    // ── Phase 1: API 数据 ──
    const { subject, characters } = await fetchSubjectAndCharacters(subjectId);
    const displayName = name || subject.name_cn || subject.name || `#${subjectId}`;
    const gameName = subject.name_cn || subject.name || '';

    // ── 质量门禁 ──
    const gate = qualityGate(subject);
    if (!gate.pass) {
      const result = {
        success: false, status: 'rejected' as const,
        message: `质量门禁未通过：${gate.reasons.join('；')}`,
        details: { subjectName: displayName, subjectId, sources: { gameIntro: false, characters: 0, comments: 0, reviews: 0, charComments: 0 }, chunksPersisted: 0 },
      };
      appendBackfillLog({ time: new Date().toISOString(), subjectId, name: displayName, status: 'rejected', nsfw: false, chunks: 0, comments: 0, reviews: 0, charComments: 0, errors: gate.reasons });
      return result;
    }

    // ── 去重检查 ──
    if (inFlightBackfills.has(subjectId)) {
      const result = { success: false, status: 'rejected' as const, message: `${displayName} 正在回填中`, details: { subjectName: displayName, subjectId, sources: { gameIntro: false, characters: 0, comments: 0, reviews: 0, charComments: 0 }, chunksPersisted: 0 } };
      appendBackfillLog({ time: new Date().toISOString(), subjectId, name: displayName, status: 'rejected', nsfw: false, chunks: 0, comments: 0, reviews: 0, charComments: 0, errors: ['正在回填中'] });
      return result;
    }
    if (await checkDedup(subjectId)) {
      const result = { success: false, status: 'rejected' as const, message: `知识库中已存在 ${displayName} 的数据`, details: { subjectName: displayName, subjectId, sources: { gameIntro: false, characters: 0, comments: 0, reviews: 0, charComments: 0 }, chunksPersisted: 0 } };
      appendBackfillLog({ time: new Date().toISOString(), subjectId, name: displayName, status: 'rejected', nsfw: false, chunks: 0, comments: 0, reviews: 0, charComments: 0, errors: ['已存在'] });
      return result;
    }
    inFlightBackfills.add(subjectId);

    // ── Phase 2: HTML 抓取（并行） ──
    const [comments, reviews, ...charCommentLists] = await Promise.all([
      scrapeComments(subjectId),
      scrapeReviews(subjectId),
      ...characters.map(c => scrapeCharComments(c.id)),
    ]);

    // ── Phase 3: 保存 parsed JSON ──
    const saved = await saveParsedJSON(subjectId, gameName, comments, reviews, characters, charCommentLists);
    console.log(`[backfill] ${displayName} (#${subjectId}) parsed JSON 保存: comments=${saved.comments}, reviews=${saved.reviews}, charComments=${saved.charComments}`);

    // ── Phase 4: 分块 ──
    const subjectChunks = chunkSubject(subject);
    const charChunks = chunkCharacters(characters, gameName);
    const commentChunks = chunkComments(comments, gameName, subjectId);
    const reviewChunks = chunkReviews(reviews, gameName, subjectId);
    const charCommentChunks = characters.flatMap((c, i) =>
      chunkCharComments(charCommentLists[i] || [], c.name_cn || c.name || '', c.id),
    );

    const allChunks = [...subjectChunks, ...charChunks, ...commentChunks, ...reviewChunks, ...charCommentChunks];

    if (allChunks.length === 0) {
      inFlightBackfills.delete(subjectId);
      const result = { success: false, status: 'rejected' as const, message: '无回填内容', details: { subjectName: displayName, subjectId, sources: { gameIntro: subjectChunks.length > 0, characters: charChunks.length, comments: commentChunks.length, reviews: reviewChunks.length, charComments: charCommentChunks.length }, chunksPersisted: 0 } };
      appendBackfillLog({ time: new Date().toISOString(), subjectId, name: displayName, status: 'rejected', nsfw: false, chunks: 0, comments: saved.comments, reviews: saved.reviews, charComments: saved.charComments, errors: ['无回填内容'] });
      return result;
    }

    // ── Phase 5: 异步持久化 → Qdrant ──
    persistChunks(allChunks)
      .then(async (count) => {
        inFlightBackfills.delete(subjectId);
        console.log(`[backfill] ${displayName} (#${subjectId}) Qdrant 写入完成：${count} 条`);
        await disconnectBrowser();
      })
      .catch(async (err) => {
        inFlightBackfills.delete(subjectId);
        console.error(`[backfill] ${displayName} (#${subjectId}) Qdrant 写入失败：`, err);
        await disconnectBrowser();
      });

    const result = {
      success: true, status: 'accepted' as const,
      message: `${displayName} 已接受回填（${allChunks.length} 个分块正在后台处理）`,
      details: { subjectName: displayName, subjectId, sources: { gameIntro: subjectChunks.length > 0, characters: charChunks.length, comments: commentChunks.length, reviews: reviewChunks.length, charComments: charCommentChunks.length }, chunksPersisted: allChunks.length },
    };
    appendBackfillLog({ time: new Date().toISOString(), subjectId, name: displayName, status: 'accepted', nsfw: false, chunks: allChunks.length, comments: saved.comments, reviews: saved.reviews, charComments: saved.charComments, errors: [] });
    return result;
  } catch (err) {
    const msg = (err as Error).message;
    appendBackfillLog({ time: new Date().toISOString(), subjectId, name: `#${subjectId}`, status: 'error', nsfw: false, chunks: 0, comments: 0, reviews: 0, charComments: 0, errors: [msg] });
    return { success: false, status: 'error', message: `回填失败：${msg}` };
  }
}
