/**
 * LLM 辅助生成别名建议
 *
 * 读取 parsed 目录下的游戏/角色数据，对尚未有手工别名的条目
 * 调用 DeepSeek 推荐常见中文别名/俗称，输出 JSON 供 review 后
 * 手动合入 name-aliases.ts。
 *
 * 角色只处理 relation="主角" 的角色（Bangumi API 标记）。
 * 现有数据缺少 relation 字段时回退到取每游戏前 5 个角色。
 *
 * 用法：
 *   pnpm tsx scripts/suggest-aliases.ts > suggested-aliases.json
 *   # review suggested-aliases.json，将结果合入 name-aliases.ts
 */
import 'dotenv/config'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { GAME_ALIASES, PRODUCER_GAMES, CHAR_ALIASES } from '../lib/name-aliases'

const PARSED_DIR = path.resolve('scripts/data/parsed')
const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'
const BATCH_SIZE = 12
const MAX_CHARS_PER_GAME = 5

// --------------- types ---------------

interface GameInfo {
  id: number
  name: string
  nameCN: string
  summary: string
}

interface CharacterInfo {
  id: number
  name: string
  nameCN: string
  summary: string
  subjectId: number
  relation?: string
}

// --------------- data loading ---------------

async function loadGames(): Promise<GameInfo[]> {
  const dir = path.join(PARSED_DIR, 'games')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const games: GameInfo[] = []
  for (const f of files) {
    const data = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))
    if (data.summary?.trim()) {
      games.push({
        id: data.id,
        name: data.name || '',
        nameCN: data.nameCN || '',
        summary: data.summary.slice(0, 200),
      })
    }
  }
  return games
}

async function loadMainCharacters(): Promise<CharacterInfo[]> {
  const dir = path.join(PARSED_DIR, 'characters')
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const chars: CharacterInfo[] = []
  for (const f of files) {
    const gameId = parseInt(f.replace('.json', ''), 10)
    const items: any[] = JSON.parse(await readFile(path.join(dir, f), 'utf-8'))

    // 取主角：relation="主角" 的回退到位置启发（前 MAX_CHARS_PER_GAME 个）
    const hasRelation = items.some(c => c.relation !== undefined)
    const targets = hasRelation
      ? items.filter(c => c.relation === '主角')
      : items.slice(0, MAX_CHARS_PER_GAME)

    for (const item of targets) {
      if (!item.summary?.trim()) continue
      if (!item.name?.trim()) continue
      if (item.nameCN?.trim()) continue // 已有中文名的不需要建议
      chars.push({
        id: item.id,
        name: item.name,
        nameCN: item.nameCN || '',
        summary: item.summary.slice(0, 200),
        subjectId: gameId,
        relation: item.relation,
      })
    }
  }
  return chars
}

// --------------- alias coverage check ---------------

function hasGameAlias(nameCN: string, name: string): boolean {
  const gameName = nameCN || name
  for (const fullNames of Object.values(GAME_ALIASES)) {
    if (fullNames.includes(gameName)) return true
  }
  for (const games of Object.values(PRODUCER_GAMES)) {
    if (games.includes(gameName)) return true
  }
  return false
}

function hasCharAlias(nameCN: string, name: string): boolean {
  const charName = nameCN || name
  for (const jpNames of Object.values(CHAR_ALIASES)) {
    if (jpNames.includes(charName)) return true
  }
  return false
}

// --------------- LLM ---------------

async function llmSuggest(prompt: string): Promise<string> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: '你是一个Galgame/美少女游戏领域的别名专家。'
            + '根据提供的游戏或角色信息，推荐常见的中文别名/俗称/网络梗称。'
            + '只输出JSON数组，不要其他内容，不要markdown代码块。',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM API ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.choices[0].message.content.trim()
}

// --------------- batch prompts ---------------

function buildGameBatchPrompt(batch: GameInfo[]): string {
  return `请为以下每个游戏推荐最多 2 个最常见的中文别名/俗称/简称。
要求：
- 只输出真正在玩家社区流通的俗称，如"素晴日"之于"美好的每一天"
- 不要角色、职业、关系称谓（如"主角""女主角""老师"等）
- 如果输入的游戏名本身已经是俗称，可以不输出别名（输出空数组 []）
- 如果某个子版本/续作有独立的常见别称，也一并给出

格式：{"游戏ID": ["别名1", "别名2", ...]}

游戏列表：
${batch.map(g =>
  `ID ${g.id}: 中文名="${g.nameCN}", 日文名="${g.name}", 简介="${g.summary}"`
).join('\n')}`
}

function buildCharBatchPrompt(batch: CharacterInfo[], gameNames: Map<number, string>): string {
  return `请为以下每个角色推荐最多 2 个最常见的中文译名/俗称。
要求：
- 只输出真实流通的玩家俗称或官方中文译名
- 严禁输出角色、职业、关系称谓（如"主角""女主角""学生""教师""老师""侦探""警察""父亲""母亲"等）
- 别名可以来自中文网络社区常见翻译或角色名字的变体

格式：{"角色ID": ["别名1", "别名2", ...]}

角色列表：
${batch.map(c =>
  `ID ${c.id}: 日文名="${c.name}", 所属游戏="${gameNames.get(c.subjectId) || '未知'}", 简介="${c.summary}"`
).join('\n')}`
}

// --------------- main ---------------

interface SuggestionResult {
  games: Record<string, string[]>
  characters: Record<string, string[]>
}

async function main() {
  console.error('=== LLM 别名建议生成 ===\n')

  // 1. 加载数据
  console.error('加载游戏数据...')
  const games = await loadGames()
  console.error(`  ${games.length} 个游戏`)

  console.error('加载主角数据（relation="主角" / 前5个）...')
  const allChars = await loadMainCharacters()
  console.error(`  ${allChars.length} 个主角`)

  // 2. 过滤已有别名
  const gamesNeeded = games.filter(g => !hasGameAlias(g.nameCN, g.name))
  const charsNeeded = allChars.filter(c => !hasCharAlias(c.nameCN, c.name))

  console.error(`\n需建议别名的游戏: ${gamesNeeded.length}/${games.length}`)
  console.error(`需建议别名的角色: ${charsNeeded.length}/${allChars.length}`)

  if (gamesNeeded.length === 0 && charsNeeded.length === 0) {
    console.error('\n无需建议，退出。')
    console.log(JSON.stringify({ games: {}, characters: {} }, null, 2))
    return
  }

  // 3. 构建 gameName 查找表（角色 prompt 用）
  const gameNameMap = new Map<number, string>()
  for (const g of games) gameNameMap.set(g.id, g.nameCN || g.name)

  // 4. 调 LLM
  const result: SuggestionResult = { games: {}, characters: {} }

  // 4a. 游戏
  for (let i = 0; i < gamesNeeded.length; i += BATCH_SIZE) {
    const batch = gamesNeeded.slice(i, i + BATCH_SIZE)
    console.error(`\n游戏 batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(gamesNeeded.length / BATCH_SIZE)}...`)
    try {
      const output = await llmSuggest(buildGameBatchPrompt(batch))
      const parsed = JSON.parse(output)
      for (const [id, aliases] of Object.entries(parsed)) {
        if (Array.isArray(aliases) && aliases.length > 0) {
          result.games[id] = aliases as string[]
        }
      }
    } catch (e: any) {
      console.error(`  失败: ${e.message}`)
    }
  }

  // 4b. 角色
  for (let i = 0; i < charsNeeded.length; i += BATCH_SIZE) {
    const batch = charsNeeded.slice(i, i + BATCH_SIZE)
    console.error(`\n角色 batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(charsNeeded.length / BATCH_SIZE)}...`)
    try {
      const output = await llmSuggest(buildCharBatchPrompt(batch, gameNameMap))
      const parsed = JSON.parse(output)
      for (const [id, aliases] of Object.entries(parsed)) {
        if (Array.isArray(aliases) && aliases.length > 0) {
          result.characters[id] = aliases as string[]
        }
      }
    } catch (e: any) {
      console.error(`  失败: ${e.message}`)
    }
  }

  // 5. 输出（stdout=JSON, stderr=日志）
  console.error(`\n=== 完成: ${Object.keys(result.games).length} 游戏, ${Object.keys(result.characters).length} 角色 ===`)
  console.log(JSON.stringify(result, null, 2))
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
