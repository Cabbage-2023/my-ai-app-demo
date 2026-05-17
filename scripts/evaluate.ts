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
  /** 对比类用：所有 expect 必须同时出现在 top-K 才算命中 */
  expects?: Record<string, string>[]
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
  // ============ 事实类 (25)：纯查表，基于真实数据 ============
  { id: 'F01', category: 'fact',   question: '古河渚是个什么样的人',                    expect: { charName: '古河渚' },       theme: '古河渚',     note: 'CLANNAD 女主角简介' },
  { id: 'F02', category: 'fact',   question: '坂上智代是什么样的女孩',                  expect: { charName: '坂上智代' },     theme: '坂上智代',   note: 'CLANNAD 角色简介' },
  { id: 'F03', category: 'fact',   question: '水上由岐的角色介绍',                      expect: { charName: '水上由岐' },     theme: '水上由岐',   note: '素晴日角色简介' },
  { id: 'F04', category: 'fact',   question: '命运石之门是什么样的游戏',                expect: { gameName: '命运石之门' },   theme: '命运石之门', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F05', category: 'fact',   question: '沙耶之歌是什么样的作品',                  expect: { gameName: '沙耶之歌' },     theme: '沙耶之歌',   expectType: 'game_intro', note: '游戏简介' },
  { id: 'F06', category: 'fact',   question: '魔法使之夜的剧情简介',                    expect: { gameName: '魔法使之夜' },   theme: '魔法使之夜', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F07', category: 'fact',   question: '装甲恶鬼村正是什么游戏',                  expect: { gameName: '装甲恶鬼村正' }, theme: '装甲恶鬼村正', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F08', category: 'fact',   question: 'Muv-Luv Alternative 是什么游戏',          expect: { gameName: 'Muv-Luv Alternative' }, theme: 'Muv-Luv Alternative', expectType: 'game_intro', note: '游戏简介' },
  { id: 'F09', category: 'fact',   question: 'CLANNAD 的故事背景',                      expect: { gameName: 'CLANNAD' },      theme: 'CLANNAD',    expectType: 'game_intro', note: '游戏简介' },
  { id: 'F10', category: 'fact',   question: '樱之诗是什么类型的游戏',                  expect: { gameName: '樱之诗' },       theme: '樱之诗',     expectType: 'game_intro', note: '全名"樱之诗 - 在樱花之森上飞舞"' },
  { id: 'F11', category: 'fact',   question: '夏日口袋是什么样的游戏',                  expect: { gameName: '夏日口袋' },     theme: '夏日口袋',   expectType: 'game_intro', note: 'Key 社 Summer Pockets 简介' },
  { id: 'F12', category: 'fact',   question: '白色相簿2序章讲了什么',                   expect: { gameName: '白色相簿2 序章' }, theme: '白色相簿2',  expectType: 'game_intro', note: 'WA2 序章独立条目' },
  { id: 'F13', category: 'fact',   question: '秋之回忆2是什么游戏',                     expect: { gameName: '秋之回忆2' },    theme: '秋之回忆2',  expectType: 'game_intro', note: 'MO2 独立条目' },
  { id: 'F14', category: 'fact',   question: '美好的每一天是什么样的游戏',               expect: { gameName: '美好的每一天' },  theme: '美好的每一天', expectType: 'game_intro', note: '素晴日存为"美好的每一天 ～不连续的存在～"' },
  { id: 'F15', category: 'fact',   question: '人狼村之谜是什么类型的游戏',              expect: { gameName: '人狼村之谜' },   theme: '人狼村之谜', expectType: 'game_intro', note: '悬疑推理游戏简介' },
  { id: 'F16', category: 'fact',   question: '五彩斑斓的世界是什么样的游戏',             expect: { gameName: '五彩斑斓的世界' }, theme: '五彩斑斓的世界', expectType: 'game_intro', note: 'CUBE 社作品简介' },
  { id: 'F17', category: 'fact',   question: '丸子与银河龙是什么游戏',                  expect: { gameName: '丸子与银河龙' }, theme: '丸子与银河龙', expectType: 'game_intro', note: '动画式 Galgame 简介' },
  { id: 'F18', category: 'fact',   question: '月姬是什么样的作品',                      expect: { gameName: '月姬' },         theme: '月姬',       expectType: 'game_intro', note: 'Type-Moon 原点作品' },
  { id: 'F19', category: 'fact',   question: '多娜多娜一起干坏事吧是什么游戏',           expect: { gameName: '多娜多娜 一起干坏事吧' }, theme: '多娜多娜', expectType: 'game_intro', note: 'Alice Soft 作品简介' },
  { id: 'F20', category: 'fact',   question: '潜伏之赤途是什么游戏',                    expect: { gameName: '潜伏之赤途' },   theme: '潜伏之赤途', expectType: 'game_intro', note: '国产文字冒险游戏简介' },
  { id: 'F21', category: 'fact',   question: '星之终途是什么样的游戏',                  expect: { gameName: '星之终途' },     theme: '星之终途',   expectType: 'game_intro', note: 'Key 社短篇作品简介' },
  { id: 'F22', category: 'fact',   question: '樱花萌放是什么类型的游戏',                expect: { gameName: '樱花、萌放。-as the Night\'s, Reincarnation-' }, theme: '樱花萌放', expectType: 'game_intro', note: '雪 Clip 社作品简介' },
  { id: 'F23', category: 'fact',   question: '恋狱月狂病是什么游戏',                    expect: { gameName: '恋狱～月狂病～' }, theme: '恋狱月狂病', expectType: 'game_intro', note: '铃鹿系列首作简介' },
  { id: 'F24', category: 'fact',   question: '青空下的约定是什么游戏',                  expect: { gameName: '青空下的约定' }, theme: '青空下的约定', expectType: 'game_intro', note: '丸户史明作品简介' },
  { id: 'F25', category: 'fact',   question: '我们没有翅膀是什么游戏',                  expect: { gameName: '我们没有翅膀' }, theme: '我们没有翅膀', expectType: 'game_intro', note: 'Navel 群像剧简介' },

  // ============ 观点类 (100+)：从评论中检索观点 ============

  // --- 角色评价 ---
  { id: 'O01', category: 'opinion', question: '古河渚为什么这么多人喜欢',                expect: { charName: '古河渚' },      theme: '古河渚',     note: '角色评论/评价' },
  { id: 'O02', category: 'opinion', question: '玩过白色相簿2的来说说冬马和纱',            expect: { charName: '冬马和纱' },    theme: '冬马和纱',   note: '角色评论—日文名模糊匹配' },
  { id: 'O03', category: 'opinion', question: '大家对坂上智代什么看法',                  expect: { charName: '坂上智代' },    theme: '坂上智代',   note: '角色评论' },
  { id: 'O04', category: 'opinion', question: '小木曾雪菜的性格怎么样',                  expect: { charName: '小木曾雪菜' },  theme: '小木曾雪菜', note: '角色评论—繁体"曽"模糊匹配' },
  { id: 'O05', category: 'opinion', question: '介绍 Saber 这个角色',                     expect: { charName: 'Saber' },        theme: 'Saber',      note: '英文名角色，当前数据可能未收录' },
  { id: 'O06', category: 'opinion', question: '牧濑红莉栖是个什么样的角色',              expect: { charName: '牧瀬紅莉栖' },  theme: '牧瀬紅莉栖',  note: '命运石之门女主角评论' },
  { id: 'O07', category: 'opinion', question: '北原春希这个人怎么样',                    expect: { charName: '北原春希' },     theme: '北原春希',   note: 'WA2 男主角评价' },
  { id: 'O08', category: 'opinion', question: '说说阿万音铃羽这个角色',                  expect: { charName: '阿万音鈴羽' },   theme: '阿万音鈴羽',  note: '命运石之门角色评论' },
  { id: 'O09', category: 'opinion', question: '北条沙都子在寒蝉里是什么角色',             expect: { charName: '北条沙都子' },   theme: '北条沙都子', note: '寒蝉鸣泣之时角色评论' },
  { id: 'O10', category: 'opinion', question: '两仪式的性格特点是什么',                  expect: { charName: '両儀式' },       theme: '両儀式',     note: '月姬/空境角色—日文名' },
  { id: 'O11', category: 'opinion', question: '琥珀和翡翠是什么样的角色',                expect: { charName: '琥珀' },          theme: '琥珀',       note: '月姬角色评价' },
  { id: 'O12', category: 'opinion', question: '大家对 Shiroyasha 什么看法',              expect: { charName: 'シロヤシャ' },   theme: 'シロヤシャ', note: '日文名角色检索' },

  // --- 剧情/玩法评价 ---
  { id: 'O13', category: 'opinion', question: 'CLANNAD 哪个情节最催泪',                  expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '从评论中找催泪情节' },
  { id: 'O14', category: 'opinion', question: '白色相簿2的剧情到底有多虐',               expect: { gameName: '白色相簿2' },   theme: '白色相簿2',  note: '找剧情评价' },
  { id: 'O15', category: 'opinion', question: '玩过命运石之门的来说说剧情怎么样',        expect: { gameName: '命运石之门' },  theme: '命运石之门', note: '找长评观点' },
  { id: 'O16', category: 'opinion', question: '素晴日的哲学引用到底是不是掉书袋',         expect: { gameName: '素晴日' },      theme: '素晴日',     note: '找有观点的长评—expect 对应"美好的每一天"' },
  { id: 'O17', category: 'opinion', question: '魔法使之夜的演出效果怎么样',              expect: { gameName: '魔法使之夜' },  theme: '魔法使之夜', note: '从评论中找具体评价点' },
  { id: 'O18', category: 'opinion', question: '装甲恶鬼村正的善恶观讲什么',              expect: { gameName: '装甲恶鬼村正' }, theme: '装甲恶鬼村正', note: '主题讨论' },
  { id: 'O19', category: 'opinion', question: '沙耶之歌的猎奇会不会劝退',                expect: { gameName: '沙耶之歌' },    theme: '沙耶之歌',   note: '找玩家真实感受' },
  { id: 'O20', category: 'opinion', question: '评价一下秽翼的尤斯蒂娅',                  expect: { gameName: '秽翼的尤斯蒂娅' }, theme: '秽翼的尤斯蒂娅', note: '游戏评价—数据量偏少' },
  { id: 'O21', category: 'opinion', question: '兰斯10的玩法怎么样',                      expect: { gameName: '兰斯10 决战' }, theme: '兰斯10',     note: '兰斯系列终章评价' },
  { id: 'O22', category: 'opinion', question: 'Muv-Luv Alternative 的剧情有多震撼',      expect: { gameName: 'Muv-Luv Alternative' }, theme: 'Muv-Luv Alternative', note: '燃系作品评价检索' },
  { id: 'O23', category: 'opinion', question: '十三机兵防卫圈的剧情到底有多神',           expect: { gameName: '十三机兵防卫圈' }, theme: '十三机兵防卫圈', note: 'SF悬疑剧情评价' },
  { id: 'O24', category: 'opinion', question: '人狼村之谜的推理质量怎么样',              expect: { gameName: '人狼村之谜' },  theme: '人狼村之谜', note: '推理轮回系评价' },
  { id: 'O25', category: 'opinion', question: '传颂之物虚伪的假面值得玩吗',              expect: { gameName: '传颂之物-虚伪的假面-' }, theme: '传颂之物', note: '系列作品评价' },
  { id: 'O26', category: 'opinion', question: '夏日口袋的剧情怎么样',                    expect: { gameName: '夏日口袋' },    theme: '夏日口袋',   note: 'Key 社作品评价' },
  { id: 'O27', category: 'opinion', question: '天津罪这部作品的评价',                    expect: { gameName: '天津罪' },       theme: '天津罪',     note: '和风奇幻作品评价' },
  { id: 'O28', category: 'opinion', question: '死月妖花是什么类型的游戏',                expect: { gameName: '死月妖花' },    theme: '死月妖花',   note: '同人悬疑巨作评价' },
  { id: 'O29', category: 'opinion', question: '海猫鸣泣之时的推理能信吗',                expect: { gameName: '海猫鸣泣之时' }, theme: '海猫鸣泣之时', note: '反推理作品评价' },
  { id: 'O30', category: 'opinion', question: '苍之彼方的四重奏好玩吗',                  expect: { gameName: '苍之彼方的四重奏' }, theme: '苍之彼方的四重奏', note: '航空竞技类评价' },
  { id: 'O31', category: 'opinion', question: 'Rewrite 这游戏怎么样',                    expect: { gameName: 'Rewrite' },     theme: 'Rewrite',    note: 'Key 社作品评价' },
  { id: 'O32', category: 'opinion', question: '车轮之国向日葵的少女剧情如何',            expect: { gameName: '车轮之国、向日葵的少女' }, theme: '车轮之国', note: '社会题材评价' },
  { id: 'O33', category: 'opinion', question: '纸上的魔法使值得玩吗',                    expect: { gameName: '纸上魔法使' },  theme: '纸上魔法使', note: '剧情作评价' },
  { id: 'O34', category: 'opinion', question: '金辉恋曲四重奏好不好玩',                  expect: { gameName: '金辉恋曲四重奏' }, theme: '金辉恋曲四重奏', note: '萌系作品评价' },
  { id: 'O35', category: 'opinion', question: '美好的每一天的哲学主题是什么',             expect: { gameName: '美好的每一天' }, theme: '美好的每一天', note: '素晴日主题讨论' },
  { id: 'O36', category: 'opinion', question: '兰斯系列的 gameplay 怎么样',              expect: { gameName: '兰斯10 决战' }, theme: '兰斯',      note: '跨作品玩法评价' },
  { id: 'O37', category: 'opinion', question: 'FLOWERS 系列值得入坑吗',                  expect: { gameName: 'FLOWERS 夏篇' }, theme: 'FLOWERS',    note: '百合系列评价' },
  { id: 'O38', category: 'opinion', question: '交响乐之雨的音乐怎么样',                  expect: { gameName: '交响乐之雨' },  theme: '交响乐之雨', note: '音乐主题作品评价' },
  { id: 'O39', category: 'opinion', question: '大图书馆的牧羊人好玩吗',                  expect: { gameName: '大图书馆的牧羊人' }, theme: '大图书馆的牧羊人', note: '八月社作品评价' },
  { id: 'O40', category: 'opinion', question: '奇异恩典圣夜的小镇评价',                  expect: { gameName: '奇异恩典·圣夜的小镇' }, theme: '奇异恩典', note: '冬宫社作品评价' },
  { id: 'O41', category: 'opinion', question: '灰色乐园剧情深度如何',                    expect: { gameName: '灰色的乐园' },  theme: '灰色的乐园', note: 'Frontwing 系列评价' },
  { id: 'O42', category: 'opinion', question: 'King Exit 和 Demons Roots 哪个剧情好',    expect: { gameName: 'King Exit' },   theme: 'King Exit',  note: '同人社RPG评价(一)' },
  { id: 'O43', category: 'opinion', question: 'Demons Roots 这游戏怎么样',               expect: { gameName: 'Demons Roots' }, theme: 'Demons Roots', note: '同人社RPG评价(二)' },
  { id: 'O44', category: 'opinion', question: 'Rance 系列入坑推荐哪个',                  expect: { gameName: '兰斯03 利萨斯陷落' }, theme: '兰斯',   note: '系列入坑引导' },
  { id: 'O45', category: 'opinion', question: '柚子社有哪些作品推荐',                    expect: { gameName: '天使的星期日' }, theme: '天使的星期日', note: '柚子社(天使社)作品评价' },
  { id: 'O46', category: 'opinion', question: '拔作岛这游戏到底在讲什么',                expect: { gameName: '抜きゲーみたいな島に住んでる貧乳はどうすりゃいいですか？' }, theme: '抜きゲーみたいな島', note: '搞笑拔作评价' },

  // --- 推荐/泛查询 ---
  { id: 'O47', category: 'opinion', question: '求推荐类似 CLANNAD 的催泪游戏',           expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '找 CLANNAD 评论中的推荐' },
  { id: 'O48', category: 'opinion', question: '秋之回忆系列哪些作品值得玩',              expect: { gameName: '秋之回忆2' },   theme: '秋之回忆',   note: '系列内推荐' },
  { id: 'O49', category: 'opinion', question: '为什么白色相簿2被称为脱宅神作',           expect: { gameName: '白色相簿2' },   theme: '白色相簿2',  note: '找特定评价' },
  { id: 'O50', category: 'opinion', question: '有哪些剧情好的Galgame推荐',               expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '泛推荐—无特定目标' },
  { id: 'O51', category: 'opinion', question: '评价一下这个游戏的音乐和画面',            expect: { gameName: 'CLANNAD' },     theme: 'CLANNAD',    note: '找具体方面评价' },
  { id: 'O52', category: 'opinion', question: '求推荐剧情深刻的视觉小说',                expect: { gameName: '命运石之门' },  theme: '命运石之门', note: '泛推荐查询' },
  { id: 'O53', category: 'opinion', question: '有没有黑长直女主的Galgame推荐',            expect: { charName: '古河渚' },      theme: '古河渚',     note: '属性向推荐' },
  { id: 'O54', category: 'opinion', question: '玩过白色相簿2的来说说感受',               expect: { gameName: '白色相簿2 终章' }, theme: '白色相簿2', note: '短评类检索' },

  // --- 新增：覆盖更多游戏的评价 ---
  { id: 'O55', category: 'opinion', question: '变态监狱到底有多搞笑',                   expect: { gameName: '变态监狱' },    theme: '变态监狱',   note: '搞笑拔作评价' },
  { id: 'O56', category: 'opinion', question: '多娜多娜的玩法怎么样',                    expect: { gameName: '多娜多娜 一起干坏事吧' }, theme: '多娜多娜', note: 'Alice Soft 游戏评价' },
  { id: 'O57', category: 'opinion', question: '月姬remake的评价怎么样',                  expect: { gameName: '月姬 -A piece of blue glass moon-' }, theme: '月姬', note: '重制版评价' },
  { id: 'O58', category: 'opinion', question: '弹丸论破的推理系统怎么样',                expect: { gameName: '弹丸论破 希望的学园和绝望高中生' }, theme: '弹丸论破', note: '推理游戏评价' },
  { id: 'O59', category: 'opinion', question: '极限脱出999的解谜难吗',                   expect: { gameName: '极限脱出 9小时9人9扇门' }, theme: '极限脱出', note: '解谜游戏评价' },
  { id: 'O60', category: 'opinion', question: '悠久之翼到底有多催泪',                    expect: { gameName: '悠久之翼-前篇' }, theme: '悠久之翼',   note: '催泪作评价' },
  { id: 'O61', category: 'opinion', question: '五彩斑斓的世界这个系列怎么样',             expect: { gameName: '五彩斑斓的世界' }, theme: '五彩斑斓的世界', note: 'CUBE 社系列评价' },
  { id: 'O62', category: 'opinion', question: '天鹅之歌这种悲剧题材值得玩吗',            expect: { gameName: '天鹅之歌' },    theme: '天鹅之歌',   note: '悲剧题材评价' },
  { id: 'O63', category: 'opinion', question: '暗之部屋的氛围感如何',                    expect: { gameName: '暗之部屋' },    theme: '暗之部屋',   note: '氛围作评价' },
  { id: 'O64', category: 'opinion', question: '水仙2的剧情怎么样',                       expect: { gameName: '水仙2' },       theme: '水仙2',      note: '短篇催泪作评价' },
  { id: 'O65', category: 'opinion', question: '初雪樱值得玩吗',                          expect: { gameName: '初雪樱' },      theme: '初雪樱',     note: '新岛夕作品评价' },
  { id: 'O66', category: 'opinion', question: '从晴朗的朝色泛起之际开始的评价',          expect: { gameName: '从晴朗的朝色泛起之际开始' }, theme: '从晴朗的朝色泛起之际开始', note: '氛围作评价' },
  { id: 'O67', category: 'opinion', question: '星空的记忆这游戏怎么样',                  expect: { gameName: '星空的记忆 -Wish upon a shooting star' }, theme: '星空的记忆', note: '催泪作评价' },
  { id: 'O68', category: 'opinion', question: '我们没有翅膀的剧情结构',                  expect: { gameName: '我们没有翅膀' }, theme: '我们没有翅膀', note: '群像剧评价' },
  { id: 'O69', category: 'opinion', question: '腐姬的剧情到底有多致郁',                  expect: { gameName: '腐姬' },        theme: '腐姬',       note: '和风民俗恐怖评价' },
  { id: 'O70', category: 'opinion', question: '美少女万华镜理与迷宫的少女评价',           expect: { gameName: '美少女万华镜 -理与迷宫的少女-' }, theme: '美少女万华镜', note: '拔作评价' },
  { id: 'O71', category: 'opinion', question: '甜蜜女友2的恋爱描写怎么样',               expect: { gameName: '甜蜜女友2' },   theme: '甜蜜女友2',  note: '纯爱作评价' },
  { id: 'O72', category: 'opinion', question: '遥仰凰华的游戏评价',                      expect: { gameName: '遥仰凰华' },    theme: '遥仰凰华',   note: 'PULLTOP 作品评价' },
  { id: 'O73', category: 'opinion', question: '青空下的约定的多线剧情怎么样',            expect: { gameName: '青空下的约定' }, theme: '青空下的约定', note: '丸户史明作品评价' },
  { id: 'O74', category: 'opinion', question: '黄昏的禁忌之药的评价',                    expect: { gameName: '黄昏的禁忌之药' }, theme: '黄昏的禁忌之药', note: '民俗学题材评价' },
  { id: 'O75', category: 'opinion', question: '流景之海的艾佩理雅的诡计设计',            expect: { gameName: '流景之海的艾佩理雅' }, theme: '流景之海的艾佩理雅', note: '悬疑作评价' },
  { id: 'O76', category: 'opinion', question: '星之终途这游戏的背景设定',                expect: { gameName: '星之终途' },    theme: '星之终途',   note: 'Key 社短篇评价' },
  { id: 'O77', category: 'opinion', question: '星空列车与白的旅行评价',                  expect: { gameName: '星空列车与白的旅行' }, theme: '星空列车与白的旅行', note: '温馨短篇评价' },
  { id: 'O78', category: 'opinion', question: '战女神ZERO的游戏性怎么样',                expect: { gameName: '战女神ZERO' },  theme: '战女神ZERO',  note: 'Eushully 作品评价' },
  { id: 'O79', category: 'opinion', question: '神采炼金大师的耐玩度',                    expect: { gameName: '神采炼金大师' }, theme: '神采炼金大师', note: 'Eushully 作品评价' },
  { id: 'O80', category: 'opinion', question: '魔导巧壳的战略要素怎么样',                expect: { gameName: '魔导巧壳' },    theme: '魔导巧壳',   note: 'Eushully SLG 评价' },
  { id: 'O81', category: 'opinion', question: '天之少女作为系列收官怎么样',              expect: { gameName: '天之少女' },    theme: '天之少女',   note: '铃鹿系列结局评价' },
  { id: 'O82', category: 'opinion', question: '女仆咖啡帕露菲的评价',                    expect: { gameName: '女仆咖啡帕露菲' }, theme: '女仆咖啡帕露菲', note: '丸户史明作品评价' },
  { id: 'O83', category: 'opinion', question: '家族计划再开的剧情如何',                  expect: { gameName: '家族计划~再开~' }, theme: '家族计划',   note: '田中罗密欧作品评价' },
  { id: 'O84', category: 'opinion', question: '梦见之药的剧情深度',                      expect: { gameName: '梦见之药' },    theme: '梦见之药',   note: '深井题材评价' },
  { id: 'O85', category: 'opinion', question: '赫炎的印加诺克的黑暗风格如何',            expect: { gameName: '赫炎的印加诺克 ～何等美好的人们～' }, theme: '赫炎的印加诺克', note: '黑暗世界观评价' },
  { id: 'O86', category: 'opinion', question: '离开人们的是什么类型的作品',              expect: { gameName: '离开的人们' },  theme: '离开的人们',  note: '电波系作品评价' },
  { id: 'O87', category: 'opinion', question: '终之空remake和素晴日比怎么样',            expect: { gameName: '终之空 remake' }, theme: '终之空',    note: 'SCA-自作品评价' },
  { id: 'O88', category: 'opinion', question: '抬头看看吧看那天上的繁星怎么样',          expect: { gameName: '抬头看看吧，看那天上的繁星' }, theme: '抬头看看吧', note: 'PULLTOP 作品评价' },
  { id: 'O89', category: 'opinion', question: '野良与皇女与流浪猫之心的评价',            expect: { gameName: '野良与皇女与流浪猫之心2' }, theme: '野良与皇女', note: '欢乐向评价' },
  { id: 'O90', category: 'opinion', question: 'ISLAND 的剧情评价',                       expect: { gameName: 'ISLAND' },      theme: 'ISLAND',     note: '轮回系作品评价' },
  { id: 'O91', category: 'opinion', question: 'Kanon 的催泪程度怎么样',                  expect: { gameName: 'Kanon' },       theme: 'Kanon',      note: 'Key 社催泪作评价' },
  { id: 'O92', category: 'opinion', question: '秋之回忆系列最推荐哪一部',                expect: { gameName: '秋之回忆2' },   theme: '秋之回忆',   note: '系列入坑推荐' },
  { id: 'O93', category: 'opinion', question: '纸魔和冥契的牧神节哪个更值得玩',          expect: { gameName: '冥契的牧神节' }, theme: '冥契的牧神节', note: 'ウグイスカグラ作品评价' },
  { id: 'O94', category: 'opinion', question: 'BLACKSOULS 的剧情怎么样',                 expect: { gameName: 'BLACKSOULS -黒の童話と五魔姫-' }, theme: 'BLACKSOULS', note: '黑暗童话评价' },
  { id: 'O95', category: 'opinion', question: 'VA-11 HALL-A 的剧情和氛围',               expect: { gameName: 'VA-11 HALL-A：赛博朋克酒保行动' }, theme: 'VA-11 HALL-A', note: '赛博朋克酒保模拟评价' },
  { id: 'O96', category: 'opinion', question: '极限脱出系列的叙事诡计',                  expect: { gameName: '极限脱出 9小时9人9扇门' }, theme: '极限脱出', note: '脱出游戏评价' },
  { id: 'O97', category: 'opinion', question: '圣诞之吻的各种女主攻略感觉',              expect: { charName: '桜井梨穂子' },   theme: '桜井梨穂子', note: '圣诞之吻角色评论' },
  { id: 'O98', category: 'opinion', question: 'FLOWERS 秋篇的剧情深度',                  expect: { gameName: 'FLOWERS 秋篇' }, theme: 'FLOWERS',    note: '百合系列秋篇评价' },
  { id: 'O99', category: 'opinion', question: '妹相随黑白世界的缤纷冒险怎么样',         expect: { gameName: '妹！相随 ~黑白世界的缤纷冒险~' }, theme: '妹！相随', note: '同人作品评价' },
  { id: 'O100', category: 'opinion', question: 'BALDR SKY的游戏性和剧情平衡',            expect: { gameName: 'BALDR SKY Dive2 "RECORDARE"' }, theme: 'BALDR SKY', note: '机甲战斗+剧情评价' },

  // ============ 对比类 (25+)：跨游戏对比，limit 提升到 20 ============

  // 合并后的对比句对：每个 question 的所有 expect 必须同时出现在 top-K
  { id: 'C01', category: 'comparison', question: '白色相簿2和CLANNAD哪个更感人',        expect: { gameName: '白色相簿2 终章' }, expects: [{ gameName: '白色相簿2 终章' }, { gameName: 'CLANNAD' }], theme: '白色相簿2', note: '两大催泪作对比' },
  { id: 'C02', category: 'comparison', question: '樱之诗和樱之刻哪个好',                 expect: { gameName: '樱之诗' },       expects: [{ gameName: '樱之诗' }, { gameName: '樱之刻' }], theme: '樱之诗', note: '系列前后作对比' },
  { id: 'C03', category: 'comparison', question: '秋之回忆1和2哪个值得玩',               expect: { gameName: '秋之回忆' },     expects: [{ gameName: '秋之回忆' }, { gameName: '秋之回忆2' }], theme: '秋之回忆', note: 'MO 系列对比' },
  { id: 'C04', category: 'comparison', question: '海猫和寒蝉哪个推理更强',               expect: { gameName: '寒蝉鸣泣之时' }, expects: [{ gameName: '寒蝉鸣泣之时' }, { gameName: '海猫鸣泣之时' }], theme: '寒蝉鸣泣之时', note: '龙骑士07作品对比' },
  { id: 'C05', category: 'comparison', question: '传颂之物三部曲按什么顺序玩',            expect: { gameName: '传颂之物-虚伪的假面-' }, expects: [{ gameName: '传颂之物-虚伪的假面-' }, { gameName: '传颂之物 致逝者的摇篮曲' }, { gameName: '传颂之物-二人之白皇-' }], theme: '传颂之物', note: '系列顺序对比(三部曲)' },
  { id: 'C06', category: 'comparison', question: '壳之少女和虚之少女哪个更值得推',        expect: { gameName: '壳之少女' },     expects: [{ gameName: '壳之少女' }, { gameName: '虚之少女' }], theme: '壳之少女', note: '铃鹿系列对比' },
  { id: 'C07', category: 'comparison', question: '兰斯03和兰斯10先玩哪个',               expect: { gameName: '兰斯03 利萨斯陷落' }, expects: [{ gameName: '兰斯03 利萨斯陷落' }, { gameName: '兰斯10 决战' }], theme: '兰斯03', note: '兰斯系列入坑顺序' },
  { id: 'C08', category: 'comparison', question: '战国兰斯和兰斯10哪个更值得玩',          expect: { gameName: '战国兰斯' },     expects: [{ gameName: '战国兰斯' }, { gameName: '兰斯10 决战' }], theme: '战国兰斯', note: '兰斯系列巅峰对比' },
  { id: 'C09', category: 'comparison', question: '恋狱月狂病和壳之少女哪个更值得推',     expect: { gameName: '恋狱～月狂病～' }, expects: [{ gameName: '恋狱～月狂病～' }, { gameName: '壳之少女' }], theme: '恋狱月狂病', note: '铃鹿系列入坑选择' },
  { id: 'C10', category: 'comparison', question: '苍之彼方的四重奏本篇和 EXTRA2 区别',      expect: { gameName: '苍之彼方的四重奏' }, expects: [{ gameName: '苍之彼方的四重奏' }, { gameName: '苍之彼方的四重奏 EXTRA2' }], theme: '苍之彼方的四重奏', note: '本篇与FD对比' },
  { id: 'C11', category: 'comparison', question: 'King Exit 和 Demons Roots 哪个剧情好',  expect: { gameName: 'King Exit' },    expects: [{ gameName: 'King Exit' }, { gameName: 'Demons Roots' }], theme: 'King Exit', note: '同人RPG双雄对比' },
  { id: 'C12', category: 'comparison', question: '白色相簿2序章和终章的区别',             expect: { gameName: '白色相簿2 序章' }, expects: [{ gameName: '白色相簿2 序章' }, { gameName: '白色相簿2 终章' }], theme: '白色相簿2', note: 'WA2 序终章对比' },
  { id: 'C13', category: 'comparison', question: '时钟机关的Ley-line系列游戏顺序',        expect: { gameName: '时钟机关的Ley-line-朝雾中飘零之花-' }, expects: [{ gameName: '时钟机关的Ley-line-朝雾中飘零之花-' }, { gameName: '时钟机关的Ley-line-残影之夜将明时-' }], theme: '时钟机关的Ley-line', note: '系列顺序对比' },
  { id: 'C14', category: 'comparison', question: 'FLOWERS 夏篇和秋篇哪个好',             expect: { gameName: 'FLOWERS 夏篇' }, expects: [{ gameName: 'FLOWERS 夏篇' }, { gameName: 'FLOWERS 秋篇' }], theme: 'FLOWERS', note: '百合系列季节对比' },
  { id: 'C15', category: 'comparison', question: 'BALDR SKY 和 BALDR HEART 哪个更好',    expect: { gameName: 'BALDR SKY Dive2 "RECORDARE"' }, expects: [{ gameName: 'BALDR SKY Dive2 "RECORDARE"' }, { gameName: 'BALDR HEART' }], theme: 'BALDR SKY', note: 'BALDR 系列作品对比' },
  { id: 'C16', category: 'comparison', question: '命运石之门和 Remember11 的悬疑设计',     expect: { gameName: '命运石之门' },   expects: [{ gameName: '命运石之门' }, { gameName: 'Remember11：无限轮回的时光' }], theme: '命运石之门', note: '悬疑轮回作品对比' },
  { id: 'C17', category: 'comparison', question: '金辉恋曲四重奏本篇和 Golden Time 区别', expect: { gameName: '金辉恋曲四重奏' }, expects: [{ gameName: '金辉恋曲四重奏' }, { gameName: '金辉恋曲四重奏 -Golden Time-' }], theme: '金辉恋曲四重奏', note: '本篇与FD对比' },
  { id: 'C18', category: 'comparison', question: '星空的记忆本篇和 Eternal Heart 区别',  expect: { gameName: '星空的记忆 -Wish upon a shooting star' }, expects: [{ gameName: '星空的记忆 -Wish upon a shooting star' }, { gameName: '星空的记忆 Eternal Heart' }], theme: '星空的记忆', note: '本篇与FD对比' },
  { id: 'C19', category: 'comparison', question: '灰色乐园和灰色果实的关系',             expect: { gameName: '灰色的乐园' },   expects: [{ gameName: '灰色的乐园' }], theme: '灰色的乐园', note: '灰色系列单条对比' },
  { id: 'C20', category: 'comparison', question: '兰斯系列先玩03还是先玩6',              expect: { gameName: '兰斯03 利萨斯陷落' }, expects: [{ gameName: '兰斯03 利萨斯陷落' }, { gameName: '兰斯6 - 赛斯崩坏 -' }], theme: '兰斯03', note: '兰斯系列入坑路线对比' },
  { id: 'C21', category: 'comparison', question: 'Muv-Luv Alternative 和 BALDR SKY 哪个燃', expect: { gameName: 'Muv-Luv Alternative' }, expects: [{ gameName: 'Muv-Luv Alternative' }, { gameName: 'BALDR SKY Dive2 "RECORDARE"' }], theme: 'Muv-Luv Alternative', note: '燃系作品对比' },
  { id: 'C22', category: 'comparison', question: '素晴日和终之空remake的关系',           expect: { gameName: '美好的每一天' }, expects: [{ gameName: '美好的每一天' }, { gameName: '终之空 remake' }], theme: '美好的每一天', note: 'SCA-自世界观对比' },
  { id: 'C23', category: 'comparison', question: '丸户史明的帕露菲和青空下哪个好',       expect: { gameName: '女仆咖啡帕露菲' }, expects: [{ gameName: '女仆咖啡帕露菲' }, { gameName: '青空下的约定' }], theme: '女仆咖啡帕露菲', note: '丸户史明作品对比' },
  { id: 'C24', category: 'comparison', question: '水仙2和星之终途哪个更催泪',            expect: { gameName: '水仙2' },       expects: [{ gameName: '水仙2' }, { gameName: '星之终途' }], theme: '水仙2', note: 'Key 社短篇催泪对比' },
  { id: 'C25', category: 'comparison', question: 'Eushully 的战女神和神采哪个耐玩',       expect: { gameName: '战女神ZERO' },  expects: [{ gameName: '战女神ZERO' }, { gameName: '神采炼金大师' }], theme: '战女神ZERO', note: 'Eushully 作品对比' },
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
