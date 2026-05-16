import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

interface Stats {
  count: number
  min: number
  max: number
  avg: number
  median: number
  p25: number
  p75: number
  p90: number
  p95: number
  lt15: number   // <= 15 字（噪音阈值）
  lt50: number   // <= 50 字
  mid: number    // 50-200 字
  long: number   // 200-500 字
  xlong: number  // > 500 字
}

function calcStats(lens: number[]): Stats {
  if (lens.length === 0) throw new Error('empty data')
  lens.sort((a, b) => a - b)
  const sum = lens.reduce((a, b) => a + b, 0)
  const n = lens.length
  return {
    count: n,
    min: lens[0],
    max: lens[n - 1],
    avg: Math.round(sum / n),
    median: lens[Math.floor(n / 2)],
    p25: lens[Math.floor(n * 0.25)],
    p75: lens[Math.floor(n * 0.75)],
    p90: lens[Math.floor(n * 0.9)],
    p95: lens[Math.floor(n * 0.95)],
    lt15: lens.filter(l => l <= 15).length,
    lt50: lens.filter(l => l <= 50).length,
    mid: lens.filter(l => l > 50 && l <= 200).length,
    long: lens.filter(l => l > 200 && l <= 500).length,
    xlong: lens.filter(l => l > 500).length,
  }
}

function printStats(label: string, stats: Stats) {
  const pct = (v: number) => `(${Math.round(v / stats.count * 100)}%)`
  console.log(`
── ${label}（共 ${stats.count} 条）────────────────
  最短 ${stats.min} 字 | 最长 ${stats.max} 字 | 平均 ${stats.avg} 字
  P25 ${stats.p25} | 中位数 ${stats.median} | P75 ${stats.p75} | P90 ${stats.p90} | P95 ${stats.p95}

  分布：
    ≤ 15 字（噪音）: ${stats.lt15} ${pct(stats.lt15)}
    ≤ 50 字         : ${stats.lt50} ${pct(stats.lt50)}
    50-200 字       : ${stats.mid} ${pct(stats.mid)}
    200-500 字      : ${stats.long} ${pct(stats.long)}
    > 500 字        : ${stats.xlong} ${pct(stats.xlong)}`)
}

async function analyzeDir(dir: string, label: string): Promise<Stats | null> {
  try {
    const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
    const lens: number[] = []
    for (const f of files) {
      const raw = await readFile(path.join(dir, f), 'utf-8')
      const items = JSON.parse(raw)
      const arr = Array.isArray(items) ? items : [items]
      for (const item of arr) {
        // 提取文本字段：不同数据类型的字段名不同
        // review 优先取 fullContent（补爬的全文），fallback 到 summary（摘要）
        const text = item.fullContent ?? item.text ?? item.summary ?? item.content ?? ''
        lens.push(text.length)
      }
    }
    if (lens.length === 0) return null
    return calcStats(lens)
  } catch {
    return null
  }
}

async function main() {
  console.log('=== 数据长度分布分析 ===\n')

  const dirs: { path: string; label: string }[] = [
    { path: 'scripts/data/parsed/comments', label: '短评' },
    { path: 'scripts/data/parsed/reviews', label: '长评' },
    { path: 'scripts/data/parsed/char-comments', label: '角色评论' },
    { path: 'scripts/data/parsed/characters', label: '角色简介' },
    { path: 'scripts/data/parsed/games', label: '游戏简介' },
  ]

  for (const d of dirs) {
    const stats = await analyzeDir(d.path, d.label)
    if (stats) {
      printStats(d.label, stats)
    } else {
      console.log(`\n${d.label}: 无数据`)
    }
  }
}

main().catch(console.error)
