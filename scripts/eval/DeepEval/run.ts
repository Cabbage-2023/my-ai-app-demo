/**
 * DeepEval 评估桥接脚本 — 数据评估 Step 3
 *
 * 从 evaluate-generation.ts 的输出 JSON 中读取 Q&A + contexts，
 * 通过子进程调用 hallucination_test.py 计算 DeepEval hallucination 指标。
 *
 * 用法：
 *   pnpm tsx scripts/eval/DeepEval/run.ts
 *
 * 前置条件：
 *   1. 先跑 pnpm tsx scripts/eval/evaluate-generation.ts（Step 1）
 *   2. Python 环境有 deepeval
 *      pip install -r scripts/eval/DeepEval/requirements.txt
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const STEP1_RESULT_PATH = path.resolve('scripts/eval/eval-generation-result.json')
const DEEPEVAL_RESULT_PATH = path.resolve('scripts/eval/DeepEval/result.json')
const PYTHON_SCRIPT = path.resolve('scripts/eval/DeepEval/hallucination_test.py')

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

interface DeepEvalOutput {
  scores?: { hallucination: number[] }
  aggregate?: Record<string, { mean: number; min: number; max: number; median: number }>
  reasons?: string[]
  error?: string
}

async function runPython(inputData: object): Promise<DeepEvalOutput> {
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
      process.stderr.write(chunk)
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

    proc.stdin.write(JSON.stringify(inputData))
    proc.stdin.end()
  })
}

function printComparison(step1: Step1Output, de: DeepEvalOutput): void {
  console.log('='.repeat(70))
  console.log('DeepEval 评估结果 — Step 3 (vs Step 1 自写 faithfulness judge)')
  console.log('='.repeat(70))

  if (!de.aggregate) {
    console.log('\nDeepEval 评估失败，无聚合数据。')
    if (de.error) console.log(`错误: ${de.error}`)
    return
  }

  const s1All = step1.metrics.all
  const h = de.aggregate.hallucination

  console.log('\n--- 指标对照 ---\n')
  console.log('  | 指标                    | Step 1 Faithfulness | DeepEval Hallucination |')
  console.log('  |-------------------------|---------------------|------------------------|')
  if (s1All) {
    console.log(
      `  | 均值                    | ${(s1All.faithfulness.mean * 100).toFixed(1).padStart(5)}%               | ${(h.mean * 100).toFixed(1).padStart(5)}%                   |`,
    )
  }
  console.log(
    `  | 中位数                  |                     | ${(h.median * 100).toFixed(1).padStart(5)}%                   |`,
  )
  console.log(
    `  | 区间                    |                     | [${(h.min * 100).toFixed(1)}% ~ ${(h.max * 100).toFixed(1)}%]                |`,
  )

  // Hallucination 高分 = 高幻觉 = 差
  const highHallucination = (de.scores?.hallucination ?? [])
    .map((v, i) => ({ score: v, detail: step1.detail[i] }))
    .filter(({ score }) => score > 0.5)
    .sort((a, b) => b.score - a.score)

  if (highHallucination.length > 0) {
    console.log(`\n--- 高幻觉风险 (hallucination > 0.5, ${highHallucination.length} 题) ---\n`)
    for (const { score, detail } of highHallucination.slice(0, 10)) {
      console.log(`    [${detail.id}] ${detail.question} → hallucination ${(score * 100).toFixed(0)}%`)
    }
    if (highHallucination.length > 10) {
      console.log(`    ...还有 ${highHallucination.length - 10} 题`)
    }
  }

  // 自写 judge ≠ DeepEval 的差异分析
  if (s1All && de.scores) {
    const diffs = de.scores.hallucination
      .map((hScore, i) => ({
        id: step1.detail[i].id,
        question: step1.detail[i].question,
        faithfulness: step1.detail[i].faithfulness,
        hallucination: hScore,
        diff: Math.abs(step1.detail[i].faithfulness - (1 - hScore)),
      }))
      .sort((a, b) => b.diff - a.diff)

    console.log(`\n--- 分歧最大 (自写 faithful vs DeepEval hallucination) ---\n`)
    for (const d of diffs.slice(0, 5)) {
      const faithfulPct = (d.faithfulness * 100).toFixed(0)
      const halluPct = (d.hallucination * 100).toFixed(0)
      console.log(`    [${d.id}] ${d.question}`)
      console.log(`          自写 faithful=${faithfulPct}%  |  DeepEval hallucination=${halluPct}%`)
    }
  }
}

async function main() {
  console.error('=== DeepEval Hallucination 评估 (Step 3) ===\n')

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

  // 2. 组装 DeepEval 输入
  const input = {
    questions: step1.detail.map(d => d.question),
    answers: step1.detail.map(d => d.answer),
    contexts: step1.detail.map(d => d.contexts || []),
  }

  // 3. 调用 Python
  console.error('正在调用 DeepEval (Python)...\n')
  const result = await runPython(input)

  if (result.error) {
    console.error('DeepEval 评估失败:', result.error)
    process.exit(1)
  }

  // 4. 保存结果
  const output = {
    date: new Date().toISOString(),
    step1Date: step1.date,
    totalPairs: step1.detail.length,
    deepeval: result,
    crossValidation: {
      faithfulnessHallucinationDiff: step1.metrics.all && result.aggregate
        ? result.aggregate.hallucination.mean - (1 - step1.metrics.all.faithfulness.mean)
        : null,
    },
  }

  let history: Array<{
    date: string
    pipeline: string
    deepevalAggregate: typeof result.aggregate
  }> = []
  try {
    const existing = JSON.parse(await readFile(DEEPEVAL_RESULT_PATH, 'utf-8'))
    if (existing.history) history = existing.history
  } catch { /* 新文件 */ }

  history.push({
    date: output.date,
    pipeline: 'hybrid+reranker',
    deepevalAggregate: result.aggregate,
  })
  ;(output as any).history = history

  await writeFile(DEEPEVAL_RESULT_PATH, JSON.stringify(output, null, 2), 'utf-8')
  console.error(`\nDeepEval 结果已保存到: ${DEEPEVAL_RESULT_PATH}（累计 ${history.length} 次运行）`)

  // 5. 打印对照表
  printComparison(step1, result)
  console.error('\n===== DeepEval 评估完成 =====')
}

main().catch((err) => {
  console.error('DeepEval 评估失败:', err)
  process.exit(1)
})
