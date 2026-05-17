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
import { generateEmbedding } from '../src/lib/ai/embedding'
import { search } from './lib/qdrant'
import type { QdrantSearchResult } from './lib/qdrant'

const RESULT_PATH = path.resolve('scripts/evaluation-result.json')

// ============================================================
// 1. QA 数据集 — 全部基于 Qdrant 真实数据
// ============================================================

interface QAPair {
  id: string
  category: 'fact' | 'opinion' | 'comparison'
  question: string
  /** 期望匹配条件——至少一个 Qdrant 结果的 payload 满足所有 KV */
  expect: Record<string, string>
  /** 主题（游戏名/角色名），用于 Precision@K 计算 */
  theme: string
  /** 期望的数据类型，用于 Type Accuracy */
  expectType?: string
  note: string
}

/**
 * 80+ 条 QA 对，基于 Qdrant 中 142 个游戏、1475 个中文角色名的真实数据。
 *
 * 分类:
 *   fact (15): 角色/游戏简介查表 — 底线验证，预期接近 100%
 *   opinion (50+): 评论/评价/推荐语义匹配 — RAG 核心指标
 *   comparison (15+): 跨游戏对比 — 加大检索量覆盖
 */
const QA_PAIRS: QAPair[] = [
  // ============ 事实类 (15)：纯查表，基于真实数据 ============
  { id: 'F01', category: 'fact',   question: '古河渚是个什么样的人',                    expect: { charName: '古河渚' },       theme: '古河渚',     note: 'CLANNAD 女主角简介' },
  { id: 'F02', category: 'fact',   question: '坂上智代是什么样的女孩',                  expect: { charName: '坂上智代' },     theme: '坂上智代',   note: 'CLANNAD 角色简介' },
  { id: 'F03', category: 'fact',   question: '水上由岐的角色介绍',                      expect: { charName: '水上由岐' },     theme: '水上由岐',   note: '素晴日角色简介' },
  { id: 'F04', category: 'fact',   question: '命运石之门是什么样的游戏',                expect: { gameName: '命运石之门' },   theme: '命运石之门', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F05', category: 'fact',   question: '沙耶之歌是什么样的作品',                  expect: { gameName: '沙耶之歌' },     theme: '沙耶之歌',   expectType: 'game_intro', note: '游戏简介' },
  { id: 'F06', category: 'fact',   question: '魔法使之夜的剧情简介',                    expect: { gameName: '魔法使之夜' },   theme: '魔法使之夜', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F07', category: 'fact',   question: '装甲恶鬼村正是什么游戏',                  expect: { gameName: '装甲恶鬼村正' }, theme: '装甲恶鬼村正', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F08', category: 'fact',   question: 'Muv-Luv Alternative 是什么游戏',          expect: { gameName: 'Muv-Luv Alternative' }, theme: 'Muv-Luv Alternative', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F09', category: 'fact',   question: 'CLANNAD 的故事背景',                      expect: { gameName: 'CLANNAD' },      theme: 'CLANNAD',    expectType: 'game_intro', note: '游戏简介' },
  { id: 'F10', category: 'fact',   question: '樱之诗是什么类型的游戏',                  expect: { gameName: '樱之诗' },       theme: '樱之诗',     expectType: 'game_intro', note: '游戏简介 — 全名"樱之诗 - 在樱花之森上飞舞"' },
  { id: 'F11', category: 'fact',   question: '夏日口袋是什么样的游戏',                  expect: { gameName: '夏日口袋' },     theme: '夏日口袋',   expectType: 'game_intro', note: 'Key 社游戏 Summer Pockets 简介' },
  { id: 'F12', category: 'fact',   question: '白色相簿2序章讲了什么',                   expect: { gameName: '白色相簿2 序章' }, theme: '白色相簿2',  expectType: 'game_intro', note: 'WA2 序章独立条目' },
  { id: 'F13', category: 'fact',   question: '秋之回忆2是什么游戏',                     expect: { gameName: '秋之回忆2' },    theme: '秋之回忆2',  expectType: 'game_intro', note: 'MO2 独立条目' },
  { id: 'F14', category: 'fact',   question: '美好的每一天是什么样的游戏',               expect: { gameName: '美好的每一天' },  theme: '美好的每一天', expectType: 'game_intro', note: '素晴日 — 存为"美好的每一天 ～不连续的存在～"' },
  { id: 'F15', category: 'fact',   question: '人狼村之谜是什么类型的游戏',              expect: { gameName: '人狼村之谜' },   theme: '人狼村之谜', expectType: 'game_intro', note: '悬疑推理游戏简介' },

  // ============ 观点类 (50+)：从评论中检索观点 ============

  // --- 角色评价 ---
  { id: 'O01', category: 'opinion', question: '古河渚为什么这么多人喜欢',                expect: { charName: '古河渚' },      theme: '古河渚',     note: '角色评论/评价' },
  { id: 'O02', category: 'opinion', question: '玩过白色相簿2的来说说冬马和纱',            expect: { charName: '冬马和纱' },    theme: '冬马和纱',   note: '角色评论 — 日文名模糊匹配' },
  { id: 'O03', category: 'opinion', question: '大家对坂上智代什么看法',                  expect: { charName: '坂上智代' },    theme: '坂上智代',   note: '角色评论' },
  { id: 'O04', category: 'opinion', question: '小木曾雪菜的性格怎么样',                  expect: { charName: '小木曾雪菜' },  theme: '小木曾雪菜', note: '角色评论 — 繁体"曽"模糊匹配' },
  { id: 'O05', category: 'opinion', question: '介绍 Saber 这个角色',                     expect: { charName: 'Saber' },        theme: 'Saber',      note: '角色检索 — 英文名，当前数据可能未收录' },
  { id: 'O21', category: 'opinion', question: '牧濑红莉栖是个什么样的角色',               expect: { charName: '牧瀬紅莉栖' },  theme: '牧瀬紅莉栖',  note: '命运石之门女主角评论' },
  { id: 'O22', category: 'opinion', question: '北原春希这个人怎么样',                    expect: { charName: '北原春希' },     theme: '北原春希',   note: 'WA2 男主角评价' },
  { id: 'O23', category: 'opinion', question: '说说阿万音铃羽这个角色',                  expect: { charName: '阿万音鈴羽' },   theme: '阿万音鈴羽',  note: '命运石之门角色评论' },
  { id: 'O24', category: 'opinion', question: '北条沙都子在寒蝉里是什么角色',             expect: { charName: '北条沙都子' },   theme: '北条沙都子', note: '寒蝉鸣泣之时角色评论' },

  // --- 剧情/玩法评价 ---
  { id: 'O06', category: 'opinion', question: 'CLANNAD 哪个情节最催泪',                  expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '从评论中找催泪情节' },
  { id: 'O07', category: 'opinion', question: '白色相簿2的剧情到底有多虐',               expect: { gameName: '白色相簿2' },   theme: '白色相簿2',  note: '找剧情评价' },
  { id: 'O08', category: 'opinion', question: '玩过命运石之门的来说说剧情怎么样',        expect: { gameName: '命运石之门' },  theme: '命运石之门', note: '找长评观点' },
  { id: 'O09', category: 'opinion', question: '素晴日的哲学引用到底是不是掉书袋',         expect: { gameName: '素晴日' },      theme: '素晴日',     note: '找有观点的长评 — 纯向量挑战，expect 对应"美好的每一天"' },
  { id: 'O10', category: 'opinion', question: '魔法使之夜的演出效果怎么样',              expect: { gameName: '魔法使之夜' },  theme: '魔法使之夜', note: '从评论中找具体评价点' },
  { id: 'O11', category: 'opinion', question: '装甲恶鬼村正的善恶观讲什么',              expect: { gameName: '装甲恶鬼村正' }, theme: '装甲恶鬼村正', note: '主题讨论' },
  { id: 'O12', category: 'opinion', question: '沙耶之歌的猎奇会不会劝退',                expect: { gameName: '沙耶之歌' },    theme: '沙耶之歌',   note: '找玩家真实感受' },
  { id: 'O13', category: 'opinion', question: '评价一下秽翼的尤斯蒂娅',                  expect: { gameName: '秽翼的尤斯蒂娅' }, theme: '秽翼的尤斯蒂娅', note: '游戏评价 — 数据量偏少' },
  { id: 'O25', category: 'opinion', question: '兰斯10的玩法怎么样',                      expect: { gameName: '兰斯10 决战' }, theme: '兰斯10',     note: '兰斯系列终章评价' },
  { id: 'O26', category: 'opinion', question: 'Muv-Luv Alternative 的剧情有多震撼',      expect: { gameName: 'Muv-Luv Alternative' }, theme: 'Muv-Luv Alternative', note: '燃系作品评价检索' },
  { id: 'O27', category: 'opinion', question: '十三机兵防卫圈的剧情到底有多神',           expect: { gameName: '十三机兵防卫圈' }, theme: '十三机兵防卫圈', note: 'SF悬疑剧情评价' },
  { id: 'O28', category: 'opinion', question: '人狼村之谜的推理质量怎么样',              expect: { gameName: '人狼村之谜' },  theme: '人狼村之谜', note: '推理轮回系评价' },
  { id: 'O29', category: 'opinion', question: '传颂之物虚伪的假面值得玩吗',              expect: { gameName: '传颂之物-虚伪的假面-' }, theme: '传颂之物', note: '系列作品评价' },
  { id: 'O30', category: 'opinion', question: '夏日口袋的剧情怎么样',                    expect: { gameName: '夏日口袋' },    theme: '夏日口袋',   note: 'Key 社作品评价' },
  { id: 'O31', category: 'opinion', question: '天津罪这部作品的评价',                    expect: { gameName: '天津罪' },       theme: '天津罪',     note: '和风奇幻作品评价' },
  { id: 'O32', category: 'opinion', question: '死月妖花是什么类型的游戏',                expect: { gameName: '死月妖花' },    theme: '死月妖花',   note: '同人悬疑巨作评价' },
  { id: 'O33', category: 'opinion', question: '海猫鸣泣之时的推理能信吗',                expect: { gameName: '海猫鸣泣之时' }, theme: '海猫鸣泣之时', note: '反推理作品评价' },
  { id: 'O34', category: 'opinion', question: '苍之彼方的四重奏好玩吗',                  expect: { gameName: '苍之彼方的四重奏' }, theme: '苍之彼方的四重奏', note: '航空竞技类评价' },

  // --- 推荐/泛查询 ---
  { id: 'O14', category: 'opinion', question: '求推荐类似 CLANNAD 的催泪游戏',           expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '找 CLANNAD 评论中的推荐' },
  { id: 'O17', category: 'opinion', question: '秋之回忆系列哪些作品值得玩',              expect: { gameName: '秋之回忆2' },   theme: '秋之回忆',   note: '系列内推荐' },
  { id: 'O18', category: 'opinion', question: '为什么白色相簿2被称为脱宅神作',           expect: { gameName: '白色相簿2' },   theme: '白色相簿2',  note: '找特定评价' },
  { id: 'O19', category: 'opinion', question: '有哪些剧情好的Galgame推荐',               expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '泛推荐 — 无特定目标' },
  { id: 'O20', category: 'opinion', question: '评价一下这个游戏的音乐和画面',            expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '找具体方面评价' },
  { id: 'O35', category: 'opinion', question: '求推荐剧情深刻的视觉小说',                expect: { gameName: '命运石之门' },  theme: '命运石之门', note: '泛推荐查询' },
  { id: 'O36', category: 'opinion', question: '有没有黑长直女主的Galgame推荐',            expect: { charName: '古河渚' },      theme: '古河渚',     note: '属性向推荐' },
  { id: 'O37', category: 'opinion', question: '玩过白色相簿2的来说说感受',               expect: { gameName: '白色相簿2 终章' }, theme: '白色相簿2', note: '短评类检索' },
  { id: 'O38', category: 'opinion', question: 'Rewrite 这游戏怎么样',                    expect: { gameName: 'Rewrite' },     theme: 'Rewrite',    note: 'Key 社作品评价' },
  { id: 'O39', category: 'opinion', question: '车轮之国向日葵的少女剧情如何',            expect: { gameName: '车轮之国、向日葵的少女' }, theme: '车轮之国', note: '社会题材评价' },
  { id: 'O40', category: 'opinion', question: '纸上的魔法使值得玩吗',                    expect: { gameName: '纸上魔法使' },  theme: '纸上魔法使', note: '剧情作评价' },
  { id: 'O41', category: 'opinion', question: '金辉恋曲四重奏好不好玩',                  expect: { gameName: '金辉恋曲四重奏' }, theme: '金辉恋曲四重奏', note: '萌系作品评价' },
  { id: 'O42', category: 'opinion', question: '美好的每一天的哲学主题是什么',             expect: { gameName: '美好的每一天' }, theme: '美好的每一天', note: '素晴日主题讨论' },
  { id: 'O43', category: 'opinion', question: '兰斯系列的 gameplay 怎么样',              expect: { gameName: '兰斯10 决战' }, theme: '兰斯',      note: '跨作品玩法评价' },
  { id: 'O44', category: 'opinion', question: 'FLOWERS 系列值得入坑吗',                  expect: { gameName: 'FLOWERS 夏篇' }, theme: 'FLOWERS',    note: '百合系列评价' },
  { id: 'O45', category: 'opinion', question: '交响乐之雨的音乐怎么样',                  expect: { gameName: '交响乐之雨' },  theme: '交响乐之雨', note: '音乐主题作品评价' },
  { id: 'O46', category: 'opinion', question: '大图书馆的牧羊人好玩吗',                  expect: { gameName: '大图书馆的牧羊人' }, theme: '大图书馆的牧羊人', note: '八月社作品评价' },
  { id: 'O47', category: 'opinion', question: '奇异恩典圣夜的小镇评价',                  expect: { gameName: '奇异恩典·圣夜的小镇' }, theme: '奇异恩典', note: '冬宫社作品评价' },
  { id: 'O48', category: 'opinion', question: '灰色乐园剧情深度如何',                    expect: { gameName: '灰色的乐园' },  theme: '灰色的乐园', note: 'Frontwing 系列评价' },
  { id: 'O49', category: 'opinion', question: 'King Exit 和 Demons Roots 哪个剧情好',    expect: { gameName: 'King Exit' },   theme: 'King Exit',  note: '同人社RPG评价(一)' },
  { id: 'O50', category: 'opinion', question: 'Demons Roots 这游戏怎么样',               expect: { gameName: 'Demons Roots' }, theme: 'Demons Roots', note: '同人社RPG评价(二)' },
  { id: 'O51', category: 'opinion', question: 'Rance 系列入坑推荐哪个',                  expect: { gameName: '兰斯03 利萨斯陷落' }, theme: '兰斯',   note: '系列入坑引导' },
  { id: 'O52', category: 'opinion', question: '柚子社有哪些作品推荐',                    expect: { gameName: '天使的星期日' }, theme: '天使的星期日', note: '柚子社(天使社)作品评价' },
  { id: 'O53', category: 'opinion', question: '拔作岛这游戏到底在讲什么',                expect: { gameName: '抜きゲーみたいな島に住んでる貧乳はどうすりゃいいですか？' }, theme: '抜きゲーみたいな島', note: '搞笑拔作评价' },

  // ============ 对比类 (16)：跨游戏对比，limit 提升到 20 ============
  { id: 'C01', category: 'comparison', question: '白色相簿2和CLANNAD哪个更感人',        expect: { gameName: '白色相簿2 终章' }, theme: '白色相簿2', note: '对比 — 两大催泪作(一) WA2' },
  { id: 'C02', category: 'comparison', question: '白色相簿2和CLANNAD哪个更感人(续)',     expect: { gameName: 'CLANNAD' },      theme: 'CLANNAD',    note: '对比 — 两大催泪作(二) CLANNAD' },
  { id: 'C03', category: 'comparison', question: '樱之诗和樱之刻哪个好(诗)',             expect: { gameName: '樱之诗' },       theme: '樱之诗',     note: '系列对比(一) 樱之诗' },
  { id: 'C04', category: 'comparison', question: '樱之诗和樱之刻哪个好(刻)',             expect: { gameName: '樱之刻' },       theme: '樱之刻',     note: '系列对比(二) 樱之刻' },
  { id: 'C05', category: 'comparison', question: '秋之回忆和秋之回忆2哪个值得玩',         expect: { gameName: '秋之回忆' },     theme: '秋之回忆',   note: '系列内对比(一) MO1' },
  { id: 'C06', category: 'comparison', question: '秋之回忆2和初代比怎么样',              expect: { gameName: '秋之回忆2' },    theme: '秋之回忆2',  note: '系列内对比(二) MO2' },
  { id: 'C07', category: 'comparison', question: '传颂之物三部曲怎么玩顺序',             expect: { gameName: '传颂之物-虚伪的假面-' }, theme: '传颂之物', note: '系列顺序(一) 虚伪的假面' },
  { id: 'C08', category: 'comparison', question: '传颂之物三部曲推荐先玩哪个',            expect: { gameName: '传颂之物 致逝者的摇篮曲' }, theme: '传颂之物', note: '系列顺序(二) 摇篮曲' },
  { id: 'C09', category: 'comparison', question: '兰斯03和兰斯10先玩哪个',               expect: { gameName: '兰斯03 利萨斯陷落' }, theme: '兰斯03',   note: '兰斯系列入坑(一)' },
  { id: 'C10', category: 'comparison', question: '兰斯10决战和战国兰斯哪个更值得玩',      expect: { gameName: '战国兰斯' },     theme: '战国兰斯',   note: '兰斯系列入坑(二)' },
  { id: 'C11', category: 'comparison', question: '壳之少女和虚之少女哪个更值得推',        expect: { gameName: '壳之少女' },     theme: '壳之少女',   note: '铃鹿系列对比(一)' },
  { id: 'C12', category: 'comparison', question: '恋狱月狂病和壳之少女比如何',           expect: { gameName: '恋狱～月狂病～' }, theme: '恋狱月狂病', note: '铃鹿系列对比(二)' },
  { id: 'C13', category: 'comparison', question: '海猫和寒蝉哪个推理更强',               expect: { gameName: '寒蝉鸣泣之时' }, theme: '寒蝉鸣泣之时', note: '龙骑士07作品对比(一)' },
  { id: 'C14', category: 'comparison', question: '海猫鸣泣之时和寒蝉比如何',             expect: { gameName: '海猫鸣泣之时' }, theme: '海猫鸣泣之时', note: '龙骑士07作品对比(二)' },
  { id: 'C15', category: 'comparison', question: '苍之彼方的四重奏和 EXTRA2 区别',        expect: { gameName: '苍之彼方的四重奏' }, theme: '苍之彼方的四重奏', note: '本篇与FD对比(一)' },
  { id: 'C16', category: 'comparison', question: '苍之彼方EXTRA2 值得玩吗',              expect: { gameName: '苍之彼方的四重奏 EXTRA2' }, theme: '苍之彼方的四重奏', note: 'FD单独评价(二)' },
]

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
  theme: string
  expectType?: string
  strictIndex: number
  fuzzyIndex: number
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
}>

/** 基线策略：纯向量搜索 */
const baselineStrategy: StrategyFn = async (qa) => {
  const embedding = await generateEmbedding(qa.question)
  const limit = qa.category === 'comparison' ? 20 : 10
  const results = await search(embedding, { limit })
  const { strictIndex, fuzzyIndex, top5 } = analyzeResults(results, qa.expect)
  return { strictIndex, fuzzyIndex, top5 }
}

// ============================================================
// 3. 匹配与指标计算
// ============================================================

/** 严格匹配：payload 字段 === 期望值 */
function strictMatch(payload: Record<string, any>, expect: Record<string, string>): boolean {
  return Object.entries(expect).every(([k, v]) => String(payload[k] ?? '') === v)
}

/** 模糊匹配：payload 字段与期望值双向 includes */
function fuzzyMatch(payload: Record<string, any>, expect: Record<string, string>): boolean {
  return Object.entries(expect).every(([k, v]) => {
    const fieldValue = String(payload[k] ?? '')
    return fieldValue === v || fieldValue.includes(v) || v.includes(fieldValue)
  })
}

/** 主题匹配：payload 中 gameName/charName/content 是否包含 theme */
function themeMatch(payload: Record<string, any>, theme: string): boolean {
  if (!theme) return false
  const fields = [String(payload.gameName ?? ''), String(payload.charName ?? ''), String(payload.content ?? '')]
  return fields.some(f => f.includes(theme))
}

/** 分析搜索结果，返回命中位置和 top5 详情 */
function analyzeResults(
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

/** 计算单组 QA 的新指标 */
function calcExtraMetrics(top5: Top5Item[], theme: string, expectType?: string) {
  const precision1 = theme && top5.length >= 1 ? top5.slice(0, 1).filter(t => themeMatch(t, theme)).length / 1 : 0
  const precision3 = theme && top5.length >= 3 ? top5.slice(0, 3).filter(t => themeMatch(t, theme)).length / 3 : 0
  const precision5 = theme && top5.length >= 5 ? top5.slice(0, 5).filter(t => themeMatch(t, theme)).length / 5 : 0
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
    const { strictIndex, fuzzyIndex, top5 } = await fn(qa)
    perQuestion.push({
      id: qa.id,
      category: qa.category,
      question: qa.question,
      note: qa.note,
      expect: qa.expect,
      theme: qa.theme,
      expectType: qa.expectType,
      strictIndex,
      fuzzyIndex,
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
    const avgPrecision1 = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.expectType).precision1, 0) / n
    const avgPrecision3 = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.expectType).precision3, 0) / n
    const avgPrecision5 = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.expectType).precision5, 0) / n
    const avgTypeAccuracy = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.expectType).typeAccuracy, 0) / n
    const avgDiversity = qs.reduce((s, q) => s + calcExtraMetrics(q.top5, q.theme, q.expectType).diversity, 0) / n

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
    const extra = calcExtraMetrics(q.top5, q.theme, q.expectType)

    console.log(`${icon} [${q.id}] ${q.question} (${q.category})`)
    console.log(`  ${q.note} | 期望 ${JSON.stringify(q.expect)} | ${mode}第${pos + 1}位 (RR=${rr})`)
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
