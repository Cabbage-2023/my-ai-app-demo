/**
 * Step 1: 生成质量评估 — Faithfulness + Answer Relevance
 *
 * 对每个 QA pair:
 *   search → 组装 context → 调 DeepSeek 生成回答 → LLM judge 打 Faithfulness / Answer Relevance 分
 *
 * 用法:
 *   pnpm tsx scripts/eval/evaluate-generation.ts
 *
 * 注意: 150 QA × 3 calls = 450 次 LLM 调用，约耗时 15-30 分钟。
 *       结果缓存在 scripts/eval/.gen-eval-cache.jsonl，中断后重新运行会跳过已缓存项。
 */
import 'dotenv/config'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { generateEmbedding } from '../../src/lib/ai/embedding'
import { search as qdrantSearch } from '../lib/qdrant'
import { QA_PAIRS, QAPair } from './qa-pairs'

// ============================================================
// 1. Config
// ============================================================

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'
const CACHE_PATH = path.resolve('scripts/eval/.gen-eval-cache.jsonl')
const RESULT_PATH = path.resolve('scripts/eval/eval-generation-result.json')
const TOP_K = 5
const MAX_CONTEXT_CHARS = 6000
const CONCURRENCY = 3

// ============================================================
// 2. Types
// ============================================================

interface JudgeScores {
  faithfulness: number
  answerRelevance: number
}

interface PerQuestionGenResult {
  id: string
  category: string
  question: string
  note: string
  contextPreview: string
  contexts: string[]   // 完整 chunk 列表（供 RAGAS 评估用）
  answer: string
  scores: JudgeScores
}

interface AggregateMetrics {
  faithfulness: { mean: number; min: number; max: number; median: number }
  answerRelevance: { mean: number; min: number; max: number; median: number }
}

// ============================================================
// 3. LLM helper
// ============================================================

async function callLLM(system: string, user: string, temperature = 0.3): Promise<string> {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: 1024,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM API ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.choices[0].message.content.trim()
}

// ============================================================
// 4. Cache (JSONL: key → value)
// ============================================================

let _cache: Map<string, string> | null = null

async function loadCache(): Promise<Map<string, string>> {
  if (_cache) return _cache
  _cache = new Map()
  if (!existsSync(CACHE_PATH)) return _cache
  const raw = await readFile(CACHE_PATH, 'utf-8')
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    try {
      const { key, value } = JSON.parse(line)
      _cache.set(key, value)
    } catch { /* skip bad lines */ }
  }
  return _cache
}

async function saveToCache(key: string, value: string): Promise<void> {
  if (!_cache) await loadCache()
  _cache!.set(key, value)
  await appendFile(CACHE_PATH, JSON.stringify({ key, value }) + '\n', 'utf-8')
}

// ============================================================
// 5. Core functions
// ============================================================

async function searchAndAssemble(qa: QAPair): Promise<{ context: string; chunkContents: string[] }> {
  const embedding = await generateEmbedding(qa.question)

  // 构建自查询 filter
  let results: Awaited<ReturnType<typeof qdrantSearch>>

  if (qa.category === 'comparison' && qa.expects && qa.expects.length > 1) {
    // 对比类多路召回 + round-robin 交错合并
    const gamesResults: Awaited<ReturnType<typeof qdrantSearch>>[] = []
    const seenIds = new Set<number>()
    for (const e of qa.expects) {
      if (!e.gameName) continue
      const conditions: Record<string, any>[] = [
        { key: 'gameName', match: { value: e.gameName } },
        { key: 'gameAliases', match: { value: e.gameName } },
      ]
      const gameFilter = { must: [{ min_should: { conditions, min_count: 1 } }] }
      gamesResults.push(await qdrantSearch(embedding, { limit: 10, filter: gameFilter }))
    }
    const merged: Awaited<ReturnType<typeof qdrantSearch>> = []
    const cursors = new Array(gamesResults.length).fill(0)
    while (merged.length < 30) {
      let added = false
      for (let g = 0; g < gamesResults.length; g++) {
        const list = gamesResults[g]
        while (cursors[g] < list.length) {
          const r = list[cursors[g]++]
          if (!seenIds.has(r.id)) {
            seenIds.add(r.id)
            merged.push(r)
            added = true
            break
          }
        }
      }
      if (!added) break
    }
    results = merged
  } else {
    let filter: Record<string, any> | undefined
    const must: Record<string, any>[] = []
    if (qa.expectType) must.push({ key: 'type', match: { value: qa.expectType } })
    const nameConditions: Record<string, any>[] = []
    if (qa.expect.gameName) {
      nameConditions.push({ key: 'gameName', match: { value: qa.expect.gameName } })
      nameConditions.push({ key: 'gameAliases', match: { value: qa.expect.gameName } })
    }
    if (qa.expect.charName) {
      nameConditions.push({ key: 'charName', match: { value: qa.expect.charName } })
      nameConditions.push({ key: 'charNameCN', match: { value: qa.expect.charName } })
      nameConditions.push({ key: 'charAliases', match: { value: qa.expect.charName } })
    }
    if (nameConditions.length > 0) {
      must.push({ min_should: { conditions: nameConditions, min_count: 1 } })
    }
    if (must.length > 0) filter = { must }
    results = await qdrantSearch(embedding, { limit: TOP_K, filter })
  }

  const chunks: string[] = []
  const chunkContents: string[] = []   // 纯内容，供 RAGAS 使用
  for (let i = 0; i < results.length; i++) {
    const p = results[i].payload as any
    const tag = [p.type || 'unknown', p.gameName || p.charName || ''].filter(Boolean).join('/')
    const content = String(p.content ?? '').slice(0, 1500)
    if (content.trim()) {
      chunks.push(`[来源 ${i + 1}] (${tag})\n${content}`)
      chunkContents.push(content)
    }
  }

  let context = chunks.join('\n\n---\n\n')
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS) + '\n\n...(truncated)'
  }
  if (!context.trim()) {
    context = '(无相关内容)'
  }

  return { context, chunkContents }
}

async function generateAnswer(question: string, context: string): Promise<string> {
  const cacheKey = `gen:${question}`
  const cache = await loadCache()
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  const system = '你是一个Galgame领域的问答助手。请基于以下上下文信息回答用户的问题。\n'
    + '要求：\n'
    + '1. 只使用上下文中提供的信息，不要编造\n'
    + '2. 如果上下文信息不足以完全回答问题，请明确指出\n'
    + '3. 引用上下文中的具体观点来支持你的回答\n'
    + '4. 用中文回答，保持简洁客观'

  const user = `上下文信息：\n${context}\n\n用户问题：${question}`
  const answer = await callLLM(system, user, 0.3)
  await saveToCache(cacheKey, answer)
  return answer
}

async function judgeFaithfulness(context: string, question: string, answer: string): Promise<number> {
  const cacheKey = `faith:${question}`
  const cache = await loadCache()
  if (cache.has(cacheKey)) return parseFloat(cache.get(cacheKey)!)

  const system = '你是一个RAG评估专家。你的任务：判断"回答"是否忠实于提供的"上下文"。\n\n'
    + '判断标准：\n'
    + '- 回答中的每个主张（claims）必须在上下文中有明确依据\n'
    + '- 如果回答包含了上下文中没有的信息，则视为不忠实\n'
    + '- 如果回答拒绝回答（说"无法回答"），且确实上下文中无相关信息，则视为忠实\n\n'
    + '只输出一个0到1之间的数字，表示忠实度分数。不要输出其他内容。\n'
    + '1.0 = 完全忠实（每个字都有依据）\n'
    + '0.5 = 部分忠实（部分依据、部分编造）\n'
    + '0.0 = 完全不忠实（完全编造）'

  const user = `上下文：\n${context}\n\n问题：${question}\n\n回答：${answer}\n\n忠实度分数：`
  const raw = await callLLM(system, user, 0.1)
  const score = parseFloat(raw)
  const clamped = isNaN(score) ? 0 : Math.max(0, Math.min(1, score))
  await saveToCache(cacheKey, String(clamped))
  return clamped
}

async function judgeAnswerRelevance(question: string, answer: string): Promise<number> {
  const cacheKey = `rel:${question}`
  const cache = await loadCache()
  if (cache.has(cacheKey)) return parseFloat(cache.get(cacheKey)!)

  const system = '你是一个RAG评估专家。你的任务：判断"回答"是否与"问题"相关。\n\n'
    + '判断标准：\n'
    + '- 一个高相关性的回答直接、完整地解决了用户的问题\n'
    + '- 如果回答答非所问、过于笼统或只回答了一小部分，分数应较低\n'
    + '- 注意回答的粒度是否匹配：问细节答细节 = 高相关，问细节答概况 = 低相关\n\n'
    + '只输出一个0到1之间的数字，表示相关性分数。不要输出其他内容。\n'
    + '1.0 = 完全相关（完美回答问题）\n'
    + '0.5 = 部分相关（回答了问题但不够完整或准确）\n'
    + '0.0 = 完全不相关（答非所问）'

  const user = `问题：${question}\n\n回答：${answer}\n\n相关性分数：`
  const raw = await callLLM(system, user, 0.1)
  const score = parseFloat(raw)
  const clamped = isNaN(score) ? 0 : Math.max(0, Math.min(1, score))
  await saveToCache(cacheKey, String(clamped))
  return clamped
}

// ============================================================
// 6. Processing pipeline
// ============================================================

async function processQA(qa: QAPair): Promise<PerQuestionGenResult> {
  const { context, chunkContents } = await searchAndAssemble(qa)
  const answer = await generateAnswer(qa.question, context)
  const faithfulness = await judgeFaithfulness(context, qa.question, answer)
  const answerRelevance = await judgeAnswerRelevance(qa.question, answer)

  return {
    id: qa.id,
    category: qa.category,
    question: qa.question,
    note: qa.note,
    contextPreview: context.slice(0, 200),
    contexts: chunkContents,
    answer,
    scores: { faithfulness, answerRelevance },
  }
}

async function processBatch(qas: QAPair[]): Promise<PerQuestionGenResult[]> {
  const results: PerQuestionGenResult[] = []
  for (let i = 0; i < qas.length; i += CONCURRENCY) {
    const batch = qas.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(qa => processQA(qa)))
    results.push(...batchResults)

    // 每批输出进度
    const done = Math.min(i + CONCURRENCY, qas.length)
    console.error(`  进度: ${done}/${qas.length} (${Math.round(done / qas.length * 100)}%)`)
  }
  return results
}

// ============================================================
// 7. Aggregation & Output
// ============================================================

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function calcAggregate(results: PerQuestionGenResult[]): AggregateMetrics {
  const faithScores = results.map(r => r.scores.faithfulness)
  const relScores = results.map(r => r.scores.answerRelevance)

  const agg = (scores: number[]) => ({
    mean: scores.reduce((s, v) => s + v, 0) / scores.length,
    min: Math.min(...scores),
    max: Math.max(...scores),
    median: median(scores),
  })

  return {
    faithfulness: agg(faithScores),
    answerRelevance: agg(relScores),
  }
}

function printSection(label: string, n: number, agg: AggregateMetrics): void {
  console.log(`  ${label} (${n} 题)`)
  console.log(`    Faithfulness:    平均 ${(agg.faithfulness.mean * 100).toFixed(1)}%  |  中位数 ${(agg.faithfulness.median * 100).toFixed(1)}%  |  区间 [${(agg.faithfulness.min * 100).toFixed(1)}% ~ ${(agg.faithfulness.max * 100).toFixed(1)}%]`)
  console.log(`    Answer Relevance:平均 ${(agg.answerRelevance.mean * 100).toFixed(1)}%  |  中位数 ${(agg.answerRelevance.median * 100).toFixed(1)}%  |  区间 [${(agg.answerRelevance.min * 100).toFixed(1)}% ~ ${(agg.answerRelevance.max * 100).toFixed(1)}%]`)
  console.log()
}

function printLowScores(results: PerQuestionGenResult[], metric: 'faithfulness' | 'answerRelevance', threshold: number, label: string): void {
  const low = results
    .filter(r => r.scores[metric] < threshold)
    .sort((a, b) => a.scores[metric] - b.scores[metric])

  if (low.length === 0) return
  console.log(`  ${label} (<${threshold * 100}%, ${low.length} 题):`)
  for (const r of low.slice(0, 10)) {
    console.log(`    [${r.id}] ${r.question} → ${(r.scores[metric] * 100).toFixed(0)}%`)
  }
  if (low.length > 10) console.log(`    ...还有 ${low.length - 10} 题`)
  console.log()
}

function printResultsTable(results: PerQuestionGenResult[]): void {
  console.log('\n===== 各分类聚合 =====\n')

  const categories: { label: string; filter: (r: PerQuestionGenResult) => boolean }[] = [
    { label: '📊 全部', filter: () => true },
    { label: '📋 事实类', filter: r => r.category === 'fact' },
    { label: '💬 观点类', filter: r => r.category === 'opinion' },
    { label: '⚖️ 对比类', filter: r => r.category === 'comparison' },
  ]

  for (const { label, filter } of categories) {
    const subset = results.filter(filter)
    if (subset.length === 0) continue
    const agg = calcAggregate(subset)
    printSection(label, subset.length, agg)
  }

  // 低分分析
  console.log('===== 低分分析 =====\n')
  printLowScores(results, 'faithfulness', 0.5, '低忠实度')
  printLowScores(results, 'answerRelevance', 0.5, '低相关性')
}

async function main() {
  console.error('=== RAG 生成质量评估 (Step 1) ===\n')
  console.error(`QA 对总数: ${QA_PAIRS.length}`)
  console.error(`缓存文件: ${CACHE_PATH}\n`)
  console.error('开始处理...\n')

  const results = await processBatch(QA_PAIRS)

  // ========== 输出到 stdout（结果部分） ==========
  console.log('='.repeat(60))
  console.log('RAG 生成质量评估结果 — Step 1: Faithfulness + Answer Relevance')
  console.log('='.repeat(60))

  const totalAgg = calcAggregate(results)
  console.log(`\n总览 (${results.length} 题):`)
  console.log(`  Faithfulness:      平均 ${(totalAgg.faithfulness.mean * 100).toFixed(1)}%  |  中位数 ${(totalAgg.faithfulness.median * 100).toFixed(1)}%`)
  console.log(`  Answer Relevance:  平均 ${(totalAgg.answerRelevance.mean * 100).toFixed(1)}%  |  中位数 ${(totalAgg.answerRelevance.median * 100).toFixed(1)}%`)

  printResultsTable(results)

  // ========== 保存 JSON 结果 ==========
  const output = {
    date: new Date().toISOString(),
    totalPairs: results.length,
    metrics: {
      all: calcAggregate(results),
      fact: calcAggregate(results.filter(r => r.category === 'fact')),
      opinion: calcAggregate(results.filter(r => r.category === 'opinion')),
      comparison: calcAggregate(results.filter(r => r.category === 'comparison')),
    },
    detail: results.map(r => ({
      id: r.id,
      category: r.category,
      question: r.question,
      answer: r.answer,
      contexts: r.contexts,
      faithfulness: r.scores.faithfulness,
      answerRelevance: r.scores.answerRelevance,
    })),
  }

  await writeFile(RESULT_PATH, JSON.stringify(output, null, 2), 'utf-8')
  console.error(`\n结果已保存到: ${RESULT_PATH}`)
  console.error('===== 评估完成 =====')
}

main().catch((err) => {
  console.error('评估失败:', err)
  process.exit(1)
})
