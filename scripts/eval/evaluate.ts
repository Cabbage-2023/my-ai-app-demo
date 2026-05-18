/**
 * RAG 检索质量评估脚本
 *
 * 80+ 条 QA 对，覆盖事实类/观点类/对比类，输出 Hit Rate@K、MRR、Precision@K、
 * Type Accuracy、Source Diversity。支持多策略对比。
 *
 * 用法:
 *   pnpm tsx scripts/evaluate.ts
 *
 * 新增策略:
 *   在 STRATEGIES 数组中添加新策略函数，跑完自动出对比表。
 */

import 'dotenv/config'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { generateEmbedding } from '../../src/lib/ai/embedding'
import { search } from '../lib/qdrant'
import type { QdrantSearchResult } from '../lib/qdrant'
import { QA_PAIRS, QAPair } from './qa-pairs'

const RESULT_PATH = path.resolve('scripts/evaluation-result.json')

// ============================================================
// 1. QA 数据集 — 全部基于 Qdrant 真实数据
// ============================================================

/**
 * 150 条 QA 对，基于 Qdrant 中 193 个游戏、1475 个中文角色名的真实数据。
 *
 * 分类:
 *   fact (25): 角色/游戏简介查表 — 底线验证，预期接近 100%
 *   opinion (100): 评论/评价/推荐语义匹配 — RAG 核心指标
 *   comparison (25): 跨游戏对比 — 加大检索量覆盖
 *
 * 定义见 qa-pairs.ts
 */

// ============================================================
// 2. 策略定义
// ============================================================

interface Top5Item {
  score: number
  type: string
  gameName: string
  charName: string
  preview: string
}

interface PerQuestionResult {
  id: string
  category: string
  question: string
  note: string
  expect: Record<string, string>
  expects?: Record<string, string>[]
  theme: string
  expectType?: string
  strictIndex: number
  fuzzyIndex: number
  /** 对比类：每个 expect 分别的命中位置，-1 表示未命中 */
  strictPositions?: number[]
  fuzzyPositions?: number[]
  top5: Top5Item[]
}

interface MetricsSnapshot {
  hitRate1: number; hitRate3: number; hitRate5: number
  mrr: number; totalHits: number; count: number
  precision1: number; precision3: number; precision5: number
  typeAccuracy: number; diversity: number
}

interface StrategyMetrics {
  all: { strict: MetricsSnapshot; fuzzy: MetricsSnapshot }
  fact: { strict: MetricsSnapshot; fuzzy: MetricsSnapshot }
  opinion: { strict: MetricsSnapshot; fuzzy: MetricsSnapshot }
  comparison: { strict: MetricsSnapshot; fuzzy: MetricsSnapshot }
}

interface StrategyResult {
  name: string
  perQuestion: PerQuestionResult[]
  metrics: StrategyMetrics
}

type StrategyFn = (qa: QAPair) => Promise<{
  strictIndex: number
  fuzzyIndex: number
  top5: Top5Item[]
  strictPositions?: number[]
  fuzzyPositions?: number[]
}>

/** 基线策略：纯向量搜索 */
const baselineStrategy: StrategyFn = async (qa) => {
  const embedding = await generateEmbedding(qa.question)
  const limit = qa.category === 'comparison' ? 20 : 10
  const results = await search(embedding, { limit })
  const { strictIndex, fuzzyIndex, top5, strictPositions, fuzzyPositions } = analyzeResults(results, qa.expect, qa.expects)
  return { strictIndex, fuzzyIndex, top5, strictPositions, fuzzyPositions }
}

// ============================================================
// 3. 匹配与指标计算
// ============================================================

/** 严格匹配：payload 字段 === 期望值（感知别名） */
function strictMatch(payload: Record<string, any>, expect: Record<string, string>): boolean {
  return Object.entries(expect).every(([k, v]) => {
    if (String(payload[k] ?? '') === v) return true
    // gameAliases 精确匹配
    if (k === 'gameName' && Array.isArray(payload.gameAliases)) {
      return payload.gameAliases.includes(v)
    }
    // charAliases 精确匹配
    if (k === 'charName' && Array.isArray(payload.charAliases)) {
      return payload.charAliases.includes(v)
    }
    return false
  })
}

/** 模糊匹配：payload 字段与期望值双向 includes（感知别名） */
function fuzzyMatch(payload: Record<string, any>, expect: Record<string, string>): boolean {
  return Object.entries(expect).every(([k, v]) => {
    const fieldValue = String(payload[k] ?? '')
    if (fieldValue === v || fieldValue.includes(v) || v.includes(fieldValue)) return true
    // gameAliases 匹配
    if (k === 'gameName' && Array.isArray(payload.gameAliases)) {
      return payload.gameAliases.some(a => a === v || a.includes(v) || v.includes(a))
    }
    // charNameCN 匹配
    if (k === 'charName' && payload.charNameCN) {
      const cn = String(payload.charNameCN)
      if (cn === v || cn.includes(v) || v.includes(cn)) return true
    }
    // charAliases 模糊匹配
    if (k === 'charName' && Array.isArray(payload.charAliases)) {
      return payload.charAliases.some(a => a === v || a.includes(v) || v.includes(a))
    }
    return false
  })
}

/** 主题匹配：按 category 分精度规则 */
function themeMatch(payload: Record<string, any>, theme: string, category: string): boolean {
  if (!theme) return false
  const charName = String(payload.charName ?? '')
  const gameName = String(payload.gameName ?? '')
  const content = String(payload.content ?? '')

  if (category === 'fact') {
    // fact：如果 theme 看起来像角色名（通常在 charName 中），优先精确匹配 charName
    if (theme.length <= 8 && charName && charName.includes(theme)) return true
    // 否则精确匹配 gameName
    if (gameName.includes(theme)) return true
    // fallback 到 content（处理 nameCN 别名场景）
    return content.includes(theme)
  }

  // opinion / comparison：保持宽松，任何字段含 theme 就算
  return [gameName, charName, content].some(f => f.includes(theme))
}

/** 分析搜索结果，返回命中位置和 top5 详情 */
function analyzeResults(
  results: QdrantSearchResult[],
  expect: Record<string, string>,
  expects?: Record<string, string>[],
) {
  if (expects && expects.length > 1) {
    return analyzeComparisonResults(results, expects)
  }
  return { ...analyzeResultsImpl(results, expect), strictPositions: undefined as number[] | undefined, fuzzyPositions: undefined as number[] | undefined }
}

/** 单 expect 匹配 */
function analyzeResultsImpl(
  results: QdrantSearchResult[],
  expect: Record<string, string>,
) {
  const strictIndex = results.findIndex((r) => strictMatch(r.payload as any, expect))
  const fuzzyIndex = results.findIndex((r) => fuzzyMatch(r.payload as any, expect))

  const top5 = results.slice(0, 5).map((r) => ({
    score: r.score,
    type: (r.payload as any).type ?? '',
    gameName: (r.payload as any).gameName ?? '',
    charName: (r.payload as any).charName ?? '',
    preview: String((r.payload as any).content ?? '').slice(0, 80),
  }))

  return { strictIndex, fuzzyIndex, top5 }
}

/** 对比类：所有 expect 必须同时出现在 top-K 才算命中 */
function analyzeComparisonResults(
  results: QdrantSearchResult[],
  expects: Record<string, string>[],
) {
  const strictPositions = expects.map(exp => results.findIndex(r => strictMatch(r.payload as any, exp)))
  const fuzzyPositions = expects.map(exp => results.findIndex(r => fuzzyMatch(r.payload as any, exp)))

  const strictHit = strictPositions.every(p => p >= 0)
  const fuzzyHit = fuzzyPositions.every(p => p >= 0)

  const strictIndex = strictHit ? Math.max(...strictPositions) : -1
  const fuzzyIndex = fuzzyHit ? Math.max(...fuzzyPositions) : -1

  const top5 = results.slice(0, 5).map((r) => ({
    score: r.score,
    type: (r.payload as any).type ?? '',
    gameName: (r.payload as any).gameName ?? '',
    charName: (r.payload as any).charName ?? '',
    preview: String((r.payload as any).content ?? '').slice(0, 80),
  }))

  return { strictIndex, fuzzyIndex, top5, strictPositions, fuzzyPositions }
}

/** 计算单组 QA 的新指标 */
function calcExtraMetrics(top5: Top5Item[], theme: string, category: string, expectType?: string) {
  const precision1 = theme && top5.length >= 1 ? top5.slice(0, 1).filter(t => themeMatch(t, theme, category)).length / 1 : 0
  const precision3 = theme && top5.length >= 3 ? top5.slice(0, 3).filter(t => themeMatch(t, theme, category)).length / 3 : 0
  const precision5 = theme && top5.length >= 5 ? top5.slice(0, 5).filter(t => themeMatch(t, theme, category)).length / 5 : 0
  const typeAccuracy = expectType && top5.length >= 5
    ? top5.slice(0, 5).filter(t => t.type === expectType).length / 5
    : 0
  const diversity = new Set(top5.filter(t => t.gameName).map(t => t.gameName)).size
  return { precision1, precision3, precision5, typeAccuracy, diversity }
}

// ============================================================
// 4. 运行评估
// ============================================================

async function runStrategy(name: string, fn: StrategyFn): Promise<StrategyResult> {
  const perQuestion: PerQuestionResult[] = []

  for (const qa of QA_PAIRS) {
    const { strictIndex, fuzzyIndex, top5, strictPositions, fuzzyPositions } = await fn(qa)
    perQuestion.push({
      id: qa.id,
      category: qa.category,
      question: qa.question,
      note: qa.note,
      expect: qa.expect,
      expects: qa.expects,
      theme: qa.theme,
      expectType: qa.expectType,
      strictIndex,
      fuzzyIndex,
      strictPositions,
      fuzzyPositions,
      top5,
    })
  }

  const calcMetrics = (qs: typeof perQuestion, getIndex: (q: PerQuestionResult) => number): MetricsSnapshot => {
    const n = qs.length || 1
    const hits1 = qs.filter((q) => getIndex(q) === 0).length
    const hits3 = qs.filter((q) => getIndex(q) >= 0 && getIndex(q) < 3).length
    const hits5 = qs.filter((q) => getIndex(q) >= 0 && getIndex(q) < 5).length
    const hits = qs.filter((q) => getIndex(q) >= 0).length
    const mrr = qs.reduce((s, q) => {
      const idx = getIndex(q)
      return s + (idx >= 0 ? 1 / (idx + 1) : 0)
    }, 0) / n

    // 新指标：对所有 QA 的 top5 聚合
    const avgPrecision1 = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.category, q.expectType).precision1, 0) / n
    const avgPrecision3 = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.category, q.expectType).precision3, 0) / n
    const avgPrecision5 = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.category, q.expectType).precision5, 0) / n
    const avgTypeAccuracy = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.category, q.expectType).typeAccuracy, 0) / n
    const avgDiversity = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.category, q.expectType).diversity, 0) / n

    return {
      hitRate1: hits1 / n, hitRate3: hits3 / n, hitRate5: hits5 / n,
      mrr, totalHits: hits, count: n,
      precision1: avgPrecision1, precision3: avgPrecision3, precision5: avgPrecision5,
      typeAccuracy: avgTypeAccuracy, diversity: avgDiversity,
    }
  }

  const metricSet = (qs: typeof perQuestion) => ({
    strict: calcMetrics(qs, (q) => q.strictIndex),
    fuzzy: calcMetrics(qs, (q) => q.fuzzyIndex),
  })

  return {
    name,
    perQuestion,
    metrics: {
      all: metricSet(perQuestion),
      fact: metricSet(perQuestion.filter(q => q.category === 'fact')),
      opinion: metricSet(perQuestion.filter(q => q.category === 'opinion')),
      comparison: metricSet(perQuestion.filter(q => q.category === 'comparison')),
    },
  }
}

// ============================================================
// 5. 输出格式化
// ============================================================

function printSummary(results: StrategyResult[]) {
  console.log('\n===== 评估结果汇总 =====\n')

  const sections: { label: string; key: 'all' | 'fact' | 'opinion' | 'comparison' }[] = [
    { label: '📊 全部', key: 'all' },
    { label: '📋 事实类', key: 'fact' },
    { label: '💬 观点类', key: 'opinion' },
    { label: '⚖️ 对比类', key: 'comparison' },
  ]

  for (const { label, key } of sections) {
    // 取第一个策略的数据来确定题目数
    const count = results[0].metrics[key].strict.count
    console.log(`  ${label} (${count} 题)`)

    // 第一行：命中率指标
    const header1 = ['策略', '匹配', 'Hit@1', 'Hit@3', 'Hit@5', 'MRR', '命中/总数']
    // 第二行：质量和多样性指标
    const header2 = ['', '', 'Prec@1', 'Prec@3', 'Prec@5', 'TypeAcc', '多样']
    const rows1 = results.flatMap((r) => {
      const m = r.metrics[key]
      return [
        [r.name, '严格', ...fmtMetrics(m.strict)],
        [r.name, '模糊', ...fmtMetrics(m.fuzzy)],
      ]
    })
    const rows2 = results.flatMap((r) => {
      const m = r.metrics[key]
      return [
        [r.name, '严格', ...fmtExtraMetrics(m.strict)],
        [r.name, '模糊', ...fmtExtraMetrics(m.fuzzy)],
      ]
    })

    const colWidths1 = header1.map((h, i) => Math.max(h.length, ...rows1.map((r) => r[i].length)))
    const colWidths2 = header2.map((h, i) => Math.max(h.length, ...rows2.map((r) => r[i].length)))
    const fmtRow1 = (cells: string[]) => '  ' + cells.map((c, i) => c.padEnd(colWidths1[i])).join(' | ')
    const fmtRow2 = (cells: string[]) => '  ' + cells.map((c, i) => c.padEnd(colWidths2[i])).join(' | ')

    console.log(fmtRow1(header1))
    console.log('  ' + colWidths1.map((w) => '─'.repeat(w)).join('─|─'))
    for (const row of rows1) console.log(fmtRow1(row))

    console.log(fmtRow2(header2))
    console.log('  ' + colWidths2.map((w) => '─'.repeat(w)).join('─|─'))
    for (const row of rows2) console.log(fmtRow2(row))
    console.log()
  }
}

function fmtMetrics(m: MetricsSnapshot): string[] {
  return [
    `${(m.hitRate1 * 100).toFixed(1)}%`,
    `${(m.hitRate3 * 100).toFixed(1)}%`,
    `${(m.hitRate5 * 100).toFixed(1)}%`,
    m.mrr.toFixed(3),
    `${m.totalHits}/${m.count}`,
  ]
}

function fmtExtraMetrics(m: MetricsSnapshot): string[] {
  return [
    `${(m.precision1 * 100).toFixed(1)}%`,
    `${(m.precision3 * 100).toFixed(1)}%`,
    `${(m.precision5 * 100).toFixed(1)}%`,
    `${(m.typeAccuracy * 100).toFixed(1)}%`,
    m.diversity.toFixed(2),
  ]
}

function printDetail(result: StrategyResult) {
  const { name, perQuestion } = result
  console.log(`\n===== ${name} — 逐题明细 =====\n`)

  const sorted = [...perQuestion].sort((a, b) => {
    const aHit = a.strictIndex >= 0 ? 0 : a.fuzzyIndex >= 0 ? 1 : 2
    const bHit = b.strictIndex >= 0 ? 0 : b.fuzzyIndex >= 0 ? 1 : 2
    if (aHit !== bHit) return aHit - bHit
    return a.id.localeCompare(b.id)
  })

  for (const q of sorted) {
    const icon = q.strictIndex >= 0 ? '✓' : q.fuzzyIndex >= 0 ? '∼' : '✗'
    const pos = q.strictIndex >= 0 ? q.strictIndex : q.fuzzyIndex
    const mode = q.strictIndex >= 0 ? '严格' : q.fuzzyIndex >= 0 ? '模糊' : '未命中'
    const rr = pos >= 0 ? (1 / (pos + 1)).toFixed(3) : '—'
    const extra = calcExtraMetrics(q.top5, q.theme, q.category, q.expectType)
    const expectStr = q.expects ? q.expects.map(e => JSON.stringify(e)).join(' + ') : JSON.stringify(q.expect)
    const positionStr = q.strictPositions
      ? `严格位置=[${q.strictPositions.join(',')}] 模糊位置=[${(q.fuzzyPositions ?? []).join(',')}]`
      : `${mode}第${pos + 1}位 (RR=${rr})`

    console.log(`${icon} [${q.id}] ${q.question} (${q.category})`)
    console.log(`  ${q.note} | 期望 ${expectStr} | ${positionStr}`)
    console.log(`  质量: Prec@5=${(extra.precision5 * 100).toFixed(0)}% TypeAcc=${(extra.typeAccuracy * 100).toFixed(0)}% 多样=${extra.diversity.toFixed(1)}`)
    console.log('  Top 5:')
    q.top5.forEach((t, i) => {
      const tag = [t.type, t.gameName || t.charName].filter(Boolean).join(' / ')
      console.log(`    ${i + 1}. [${tag}] ${(t.score * 100).toFixed(1)}% "${t.preview}..."`)
    })
    console.log()
  }
}

// ============================================================
// 6. Main
// ============================================================

async function main() {
  console.log('=== RAG 检索质量评估 ===\n')
  console.log(`QA 对总数: ${QA_PAIRS.length}\n`)

  const strategies: { name: string; fn: StrategyFn }[] = [
    { name: '纯向量搜索', fn: baselineStrategy },
  ]

  const results: StrategyResult[] = []
  for (const s of strategies) {
    console.log(`运行策略: ${s.name}...`)
    const result = await runStrategy(s.name, s.fn)
    results.push(result)
  }

  printSummary(results)
  for (const r of results) {
    printDetail(r)
  }

  // 保存结果
  const r = results[0]
  const snapshot = {
    date: new Date().toISOString(),
    totalPairs: QA_PAIRS.length,
    strategy: r.name,
    metrics: {
      all: { strict: r.metrics.all.strict, fuzzy: r.metrics.all.fuzzy },
      fact: { strict: r.metrics.fact.strict, fuzzy: r.metrics.fact.fuzzy },
      opinion: { strict: r.metrics.opinion.strict, fuzzy: r.metrics.opinion.fuzzy },
      comparison: { strict: r.metrics.comparison.strict, fuzzy: r.metrics.comparison.fuzzy },
    },
    detail: r.perQuestion.map((q) => ({
      id: q.id,
      category: q.category,
      question: q.question,
      strictIndex: q.strictIndex,
      fuzzyIndex: q.fuzzyIndex,
      strictPositions: q.strictPositions,
      fuzzyPositions: q.fuzzyPositions,
      expects: q.expects,
    })),
  }
  await writeFile(RESULT_PATH, JSON.stringify(snapshot, null, 2), 'utf-8')
  console.log(`\n结果已保存到: ${RESULT_PATH}`)
  console.log('===== 评估完成 =====')
}

main().catch((err) => {
  console.error('评估失败:', err)
  process.exit(1)
})
