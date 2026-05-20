/**
 * RAGAS 评估桥接脚本 — 数据评估 Step 2
 *
 * 从 evaluate-generation.ts 的输出 JSON 中读取 Q&A + contexts，
 * 通过子进程调用 eval-ragas.py 计算 RAGAS 指标，
 * 输出与 Step 1 结果的交叉验证对照表。
 *
 * 用法：
 *   pnpm tsx scripts/eval/RAGAS/run.ts
 *
 * 前置条件：
 *   1. 先跑 pnpm tsx scripts/eval/evaluate-generation.ts（Step 1）
 *   2. Python 环境有 ragas / datasets / numpy
 *      pip install -r scripts/eval/RAGAS/requirements.txt
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const STEP1_RESULT_PATH = path.resolve('scripts/eval/eval-generation-result.json')
const RAGAS_RESULT_PATH = path.resolve('scripts/eval/RAGAS/result.json')
const PYTHON_SCRIPT = path.resolve('scripts/eval/RAGAS/eval-ragas.py')

interface Step1Detail {
  id: string
  category: string
  question: string
  answer: string
  contexts: string[]
  reference: string
  faithfulness: number
  answerRelevance: number
}

interface Step1Output {
  date: string
  totalPairs: number
  metrics: Record<string, any>
  detail: Step1Detail[]
}

interface RagasScores {
  faithfulness: number[]
  answer_relevancy?: number[]
  context_recall?: number[]
}

interface RagasAggregate {
  [metric: string]: { mean: number; min: number; max: number; median: number }
}

interface RagasOutput {
  scores?: RagasScores
  aggregate?: RagasAggregate
  error?: string
}

async function runPython(inputData: object): Promise<RagasOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', [PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      process.stderr.write(chunk)  // 实时转发 Python 进度
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}\nstderr: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`Failed to parse Python output: ${stdout}`))
      }
    })

    proc.on('error', reject)

    // 发送输入
    proc.stdin.write(JSON.stringify(inputData))
    proc.stdin.end()
  })
}

function printComparison(step1: Step1Output, ragas: RagasOutput): void {
  console.log('='.repeat(70))
  console.log('RAGAS 评估结果 — Step 2 (vs Step 1 自写 judge)')
  console.log('='.repeat(70))

  if (!ragas.aggregate) {
    console.log('\nRAGAS 评估失败，无聚合数据。')
    if (ragas.error) console.log(`错误: ${ragas.error}`)
    return
  }

  const s1All = step1.metrics.all

  // Step 1 vs RAGAS 对照表（faithfulness 重叠指标）
  console.log('\n--- 指标对照 (Step 1 自写 judge vs RAGAS) ---\n')

  const rows: { metric: string; s1Mean: string; ragasMean: string; diff: string }[] = []

  if (s1All) {
    rows.push({
      metric: 'Faithfulness',
      s1Mean: (s1All.faithfulness.mean * 100).toFixed(1) + '%',
      ragasMean: (ragas.aggregate.faithfulness.mean * 100).toFixed(1) + '%',
      diff: ((ragas.aggregate.faithfulness.mean - s1All.faithfulness.mean) * 100).toFixed(1) + '%',
    })
  }

  console.log('  | 指标                    | Step 1 均值  | RAGAS 均值  | 差异     |')
  console.log('  |-------------------------|--------------|-------------|----------|')
  for (const row of rows) {
    console.log(`  | ${row.metric.padEnd(23)} | ${row.s1Mean.padEnd(12)} | ${row.ragasMean.padEnd(11)} | ${row.diff.padEnd(8)} |`)
  }

  // 分 category 聚合
  const categories = ['fact', 'opinion', 'comparison']
  console.log('\n--- 分类 RAGAS 指标 ---\n')
  for (const cat of categories) {
    const indices = step1.detail
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.category === cat)
      .map(({ i }) => i)

    if (indices.length === 0) continue

    const catScores: RagasAggregate = {}
    for (const [name, vals] of Object.entries(ragas.scores ?? {})) {
      const catVals = indices.map(i => vals[i]).filter(v => v !== undefined)
      if (catVals.length === 0) continue
      const sorted = [...catVals].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
      catScores[name] = {
        mean: catVals.reduce((s, v) => s + v, 0) / catVals.length,
        min: Math.min(...catVals),
        max: Math.max(...catVals),
        median,
      }
    }

    console.log(`  ${cat} (${indices.length} 题):`)
    for (const [name, agg] of Object.entries(catScores)) {
      console.log(`    ${name.padEnd(22)} 均值 ${(agg.mean * 100).toFixed(1)}%  |  中位数 ${(agg.median * 100).toFixed(1)}%  |  区间 [${(agg.min * 100).toFixed(1)}% ~ ${(agg.max * 100).toFixed(1)}%]`)
    }
    console.log()
  }

  // 低分分析（RAGAS faithfulness < 0.5）
  const lowFaith = (ragas.scores?.faithfulness ?? [])
    .map((v, i) => ({ score: v, detail: step1.detail[i] }))
    .filter(({ score }) => score < 0.5)
    .sort((a, b) => a.score - b.score)

  if (lowFaith.length > 0) {
    console.log('--- 低忠实度 (RAGAS faithfulness < 0.5) ---\n')
    for (const { score, detail } of lowFaith.slice(0, 10)) {
      console.log(`    [${detail.id}] ${detail.question} → ${(score * 100).toFixed(0)}%`)
    }
    if (lowFaith.length > 10) console.log(`    ...还有 ${lowFaith.length - 10} 题`)
    console.log()
  }
}

async function main() {
  console.error('=== RAGAS 评估 (Step 2) ===\n')

  // 1. 读取 Step 1 结果
  let step1Raw: string
  try {
    step1Raw = await readFile(STEP1_RESULT_PATH, 'utf-8')
  } catch {
    console.error(`错误: 未找到 Step 1 结果文件 ${STEP1_RESULT_PATH}`)
    console.error('请先运行: pnpm tsx scripts/eval/evaluate-generation.ts')
    process.exit(1)
  }

  const step1: Step1Output = JSON.parse(step1Raw)

  if (!step1.detail || step1.detail.length === 0) {
    console.error('错误: Step 1 结果中没有 detail 数据')
    process.exit(1)
  }

  console.error(`读取到 ${step1.detail.length} 条记录`)

  // 2. 检查是否有 contexts 数据
  const hasContexts = step1.detail.some(d => d.contexts && d.contexts.length > 0)
  if (!hasContexts) {
    console.error('错误: Step 1 结果缺少 contexts 字段。')
    console.error('请重新运行 Step 1 以生成完整数据：pnpm tsx scripts/eval/evaluate-generation.ts')
    process.exit(1)
  }

  // 3. 组装 RAGAS 输入
  const ragasInput: Record<string, any> = {
    questions: step1.detail.map(d => d.question),
    answers: step1.detail.map(d => d.answer),
    contexts: step1.detail.map(d => d.contexts || []),
  }

  // 如果有 reference，传入用于 context_recall
  const hasReference = step1.detail.some(d => d.reference)
  if (hasReference) {
    ragasInput.references = step1.detail.map(d => d.reference)
    console.error(`包含 reference（ground truth），将计算 context_recall`)
  }

  // 4. 调用 Python
  console.error('正在调用 RAGAS (Python)...')
  console.error(`问题数: ${ragasInput.questions.length}\n`)

  const ragasResult = await runPython(ragasInput)

  if (ragasResult.error) {
    console.error('RAGAS 评估失败:', ragasResult.error)
    process.exit(1)
  }

  // 5. 保存结果（累加历史）
  const output = {
    date: new Date().toISOString(),
    step1Date: step1.date,
    totalPairs: step1.detail.length,
    ragas: ragasResult,
    crossValidation: {
      faithfulnessDiff: step1.metrics.all
        ? ragasResult.aggregate!.faithfulness.mean - step1.metrics.all.faithfulness.mean
        : null,
    },
  }

  let history: Array<{
    date: string; pipeline: string
    ragasAggregate: RagasAggregate
    crossValidation: { faithfulnessDiff: number | null }
  }> = []
  try {
    const existing = JSON.parse(await readFile(RAGAS_RESULT_PATH, 'utf-8'))
    if (existing.history) history = existing.history
  } catch { /* 新文件 */ }

  history.push({
    date: output.date,
    pipeline: 'hybrid+reranker',
    ragasAggregate: output.ragas.aggregate!,
    crossValidation: output.crossValidation,
  })
  output['history'] = history

  await writeFile(RAGAS_RESULT_PATH, JSON.stringify(output, null, 2), 'utf-8')
  console.error(`\nRAGAS 结果已保存到: ${RAGAS_RESULT_PATH}（累计 ${history.length} 次运行）`)

  // 6. 打印对照表
  printComparison(step1, ragasResult)
  console.error('\n===== RAGAS 评估完成 =====')
}

main().catch((err) => {
  console.error('RAGAS 评估失败:', err)
  process.exit(1)
})
