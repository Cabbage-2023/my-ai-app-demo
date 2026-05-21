import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { generateEmbedding, generateSparseEmbedding } from "@/lib/ai/embedding";
import { searchSimilar, searchSparse } from "@/lib/qdrant";
import { rerank } from "@/lib/ai/reranker";

/**
 * getInformation — 从 Qdrant 知识库中检索与问题相关的信息。
 * 支持单问题检索（question + filter）和批量检索（questions 数组，并行执行后合并去重）。
 */
export const getInformationTool = new DynamicStructuredTool({
  name: "getInformation",
  description:
    "从知识库中检索与问题相关的信息。当你需要回忆知识库内容时调用。" +
    "对于对比类问题（比较多个游戏/角色），应使用 questions 数组传参，让多个子问题并行检索。" +
    "涉及特定角色时必须设置 filter.charName（角色全名），涉及特定游戏时必须设置 filter.gameName。" +
    "query 参数保持简洁，以实体名称为主，不要包含提问句式或评价性语言。",
  schema: z.object({
    question: z
      .string()
      .optional()
      .describe("要检索的问题（与 questions 二选一）"),
    questions: z
      .array(
        z.object({
          question: z.string().describe("子问题"),
          filter: z
            .object({
              type: z
                .union([z.string(), z.array(z.string())])
                .optional()
                .describe("过滤类型"),
              gameName: z.string().optional().describe("游戏名称"),
              charName: z.string().optional().describe("角色名称"),
            })
            .optional()
            .describe("当前子问题的过滤条件"),
        }),
      )
      .optional()
      .describe("批量检索的问题列表（与 question 二选一），并行执行后合并结果"),
    filter: z
      .object({
        type: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("过滤类型：单个类型用字符串，多个类型用数组（OR 语义）"),
        gameName: z.string().optional().describe("游戏名称（精确匹配）"),
        charName: z.string().optional().describe("角色名称（精确匹配）"),
      })
      .optional()
      .describe("检索过滤条件（可选），用于缩小检索范围"),
  }),
  func: async ({ question, questions, filter: inputFilter }) => {
    if (questions?.length) {
      const allResults = await Promise.all(
        questions.map((q) => executeSearch(q.question, q.filter || inputFilter)),
      );
      // 合并去重：同一段 content 被多个子查询搜到时只保留一次
      const seen = new Set<string>();
      const merged: ExecSearchResult[] = [];
      for (const batch of allResults) {
        for (const r of batch) {
          const key = `${r.metadata.source || ''}|${r.content.slice(0, 100)}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(r);
          }
        }
      }
      return JSON.stringify(merged.slice(0, 10));
    }

    if (question) {
      return JSON.stringify(await executeSearch(question, inputFilter));
    }

    return JSON.stringify([]);
  },
});

// ── 搜索管道工具函数 ────────────────────────────────

interface ExecSearchResult {
  content: string;
  metadata: Record<string, any>;
}

/** 构建 Qdrant filter（同名/别名字段的 min_should 策略） */
function buildQdrantFilter(
  inputFilter?: { type?: string | string[]; gameName?: string; charName?: string },
): Record<string, unknown> | undefined {
  if (!inputFilter) return undefined;

  const must: Record<string, any>[] = [];
  const should: Record<string, any>[] = [];

  if (typeof inputFilter.type === 'string') {
    must.push({ key: 'type', match: { value: inputFilter.type } });
  } else if (Array.isArray(inputFilter.type)) {
    for (const t of inputFilter.type) {
      should.push({ key: 'type', match: { value: t } });
    }
  }

  const nameConditions: Record<string, any>[] = [];
  if (inputFilter.gameName) {
    nameConditions.push(
      { key: 'gameName', match: { value: inputFilter.gameName } },
      { key: 'gameAliases', match: { value: inputFilter.gameName } },
    );
  }
  if (inputFilter.charName) {
    nameConditions.push(
      { key: 'charName', match: { value: inputFilter.charName } },
      { key: 'charNameCN', match: { value: inputFilter.charName } },
      { key: 'charAliases', match: { value: inputFilter.charName } },
    );
  }
  if (nameConditions.length > 0) {
    must.push({ min_should: { conditions: nameConditions, min_count: 1 } });
  }

  if (must.length === 0 && should.length === 0) return undefined;
  const filter: Record<string, unknown> = {};
  if (must.length > 0) filter.must = must;
  if (should.length > 0) filter.should = should;
  return filter;
}

/** 单次搜索管道：embedding → dense+sparse 双路搜索 → RRF 融合 → rerank */
async function executeSearch(
  question: string,
  inputFilter?: { type?: string | string[]; gameName?: string; charName?: string },
): Promise<ExecSearchResult[]> {
  const embedding = await generateEmbedding(question);
  const qdrantFilter = buildQdrantFilter(inputFilter);

  const denseResults = await searchSimilar(embedding, 20, qdrantFilter as any);
  const sparse = generateSparseEmbedding(question);
  const sparseResults = await searchSparse(sparse, 20, qdrantFilter as any);

  // RRF: score = 1 / (k + rank), k = 60
  const k = 60;
  const rrfScore = new Map<string, { result: (typeof denseResults)[0]; score: number }>();
  const addToRRF = (results: typeof denseResults) => {
    results.forEach((r, rank) => {
      const key = `${r.metadata.source || ''}|${r.content.slice(0, 100)}`;
      const entry = rrfScore.get(key);
      if (entry) {
        entry.score += 1 / (k + rank);
      } else {
        rrfScore.set(key, { result: r, score: 1 / (k + rank) });
      }
    });
  };
  addToRRF(denseResults);
  addToRRF(sparseResults);

  const fused = [...rrfScore.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 20)
    .map(([, { result }]) => result);

  const reranked = await rerank(question, fused, 5);

  // 置信度阈值：maxScore < 0.4 时不展示
  const maxScore = reranked.length > 0
    ? Math.max(...reranked.map((r) => r.score))
    : 0;
  if (maxScore > 0 && maxScore < 0.4) return [];

  return reranked.map((r) => ({
    content: r.content,
    metadata: { ...r.metadata, score: r.score },
  }));
}

/**
 * rewriteQuery — 查询改写工具。
 * 将口语化/模糊的用户问题改写为检索友好的关键词组合。
 * AI 在调用 getInformation 前自主决定是否需要改写。
 */
export const rewriteQueryTool = new DynamicStructuredTool({
  name: "rewriteQuery",
  description:
    "将口语化的用户问题改写为更适合检索的关键词组合。" +
    "当你觉得用户的问题比较口语化、指代模糊、或包含需要提取的关键实体时，先调用此工具改写，再用改写结果去检索。",
  schema: z.object({
    query: z.string().describe("用户原始问题"),
  }),
  func: async ({ query }) => {
    const model = new ChatOpenAI({
      model: "deepseek-v4-flash",
      apiKey: process.env.DEEPSEEK_API_KEY,
      temperature: 0.3,
      modelKwargs: {
        thinking: { type: "disabled" },
      },
      configuration: {
        baseURL: "https://api.deepseek.com",
      },
    });

    const response = await model.invoke([
      new SystemMessage(
        "你是一个查询重写助手。将用户的问句改写得更适合检索，保持原意不变，去口语化并提取关键实体。" +
        "输出仅返回改写后的文本，不要加解释。",
      ),
      new HumanMessage(query),
    ]);

    return typeof response.content === "string"
      ? response.content
      : response.content.map((c) => ("text" in c ? c.text : "")).join("");
  },
});

// ── Bangumi API 搜索工具函数 ────────────────────────────

import { COMPANY_SEARCH_ALIASES, PRODUCER_GAMES } from '../../../../scripts/lib/name-aliases';

const BANGUMI_API_BASE = 'https://api.bgm.tv';

/** 调用 Bangumi API（带 Bearer Token） */
async function fetchBangumiAPI(endpoint: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
  };
  const token = process.env.BANGUMI_API_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BANGUMI_API_BASE}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Bangumi API ${res.status}: ${endpoint}`);
  return res.json();
}

/** 搜索 Bangumi（并行搜索 subjects + characters，合并结果） */
interface BangumiSearchResult {
  source: string;
  type: string;
  id: number;
  name: string;
  summary: string;
  url: string;
  image?: string;
}

/** 展开品牌别名：如 "柚子社" → ["ゆずソフト", "Yuzu-Soft"] */
function expandSearchQuery(query: string): string[] {
  if (COMPANY_SEARCH_ALIASES[query]) {
    return COMPANY_SEARCH_ALIASES[query];
  }
  const withoutSha = query.endsWith('社') ? query.slice(0, -1) : query;
  if (COMPANY_SEARCH_ALIASES[withoutSha]) {
    return COMPANY_SEARCH_ALIASES[withoutSha];
  }
  for (const [key, aliases] of Object.entries(COMPANY_SEARCH_ALIASES)) {
    if (query.includes(key)) {
      return aliases;
    }
  }
  return [query];
}

/** 如果 query 匹配已知制作商，返回旗下游戏标题列表 */
function getProducerGames(query: string): string[] {
  // 精确匹配
  if (PRODUCER_GAMES[query]) return PRODUCER_GAMES[query];
  const withoutSha = query.endsWith('社') ? query.slice(0, -1) : query;
  if (PRODUCER_GAMES[withoutSha]) return PRODUCER_GAMES[withoutSha];
  // 别名展开后再匹配（如 ゆずソフト → 柚子社）
  for (const [key, aliases] of Object.entries(COMPANY_SEARCH_ALIASES)) {
    if (aliases.includes(query) || aliases.includes(withoutSha)) {
      if (PRODUCER_GAMES[key]) return PRODUCER_GAMES[key];
    }
  }
  return [];
}

/** 单次 Bangumi 关键词搜索（subjects + characters） */
async function searchBangumiSingle(term: string): Promise<BangumiSearchResult[]> {
  const results: BangumiSearchResult[] = [];

  const [subjectRes, charRes] = await Promise.allSettled([
    fetchBangumiAPI('/v0/search/subjects', { keyword: term, filter: { type: [4] }, limit: 5 }),
    fetchBangumiAPI('/v0/search/characters', { keyword: term, limit: 3 }),
  ]);

  if (subjectRes.status === 'fulfilled' && subjectRes.value?.data) {
    for (const item of subjectRes.value.data) {
      results.push({
        source: 'bangumi',
        type: item.type === 4 ? 'game' : 'subject',
        id: item.id,
        name: item.name_cn || item.name || '',
        summary: (item.summary || '').slice(0, 300),
        url: `https://bangumi.tv/subject/${item.id}`,
        image: item.images?.large || item.images?.medium || '',
      });
    }
  }

  if (charRes.status === 'fulfilled' && charRes.value?.data) {
    for (const item of charRes.value.data) {
      results.push({
        source: 'bangumi',
        type: 'character',
        id: item.id,
        name: item.name || '',
        summary: (item.summary || '').slice(0, 300),
        url: `https://bangumi.tv/character/${item.id}`,
        image: item.images?.large || item.images?.medium || '',
      });
    }
  }

  return results;
}

/**
 * 搜索 Bangumi（支持品牌别名扩展 + rerank 去噪）。
 * 如果 query 是品牌俗称（如柚子社），自动用日文/英文名搜索后合并结果。
 */
async function searchBangumi(query: string): Promise<BangumiSearchResult[]> {
  const terms = expandSearchQuery(query);

  // 用每个搜索词并行搜索，合并结果
  const allResults = await Promise.all(terms.map(t => searchBangumiSingle(t)));

  // 去重合并：相同 id 只保留一次
  const seen = new Set<number>();
  const merged: BangumiSearchResult[] = [];
  for (const batch of allResults) {
    for (const r of batch) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }
  }

  // 如果 query 匹配已知制作商，同时搜旗下游戏标题（最多 5 款）
  const producerGames = getProducerGames(query)
    .filter((g) => !merged.some((m) => m.name.includes(g.slice(0, 6))));
  if (producerGames.length > 0) {
    const gameResults = await Promise.all(
      producerGames.slice(0, 5).map((g) => searchBangumiSingle(g)),
    );
    for (const batch of gameResults) {
      for (const r of batch) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          merged.push(r);
        }
      }
    }
  }

  // 如果别名搜索结果太少，用原始查询再搜一次作为 fallback
  if (merged.length < 2 && !terms.includes(query)) {
    const fallback = await searchBangumiSingle(query);
    for (const r of fallback) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }
  }

  // rerank 去噪：按 query 相关性从高到低排序，过滤低分结果
  if (merged.length > 1) {
    const forRerank = merged.map((r) => ({
      content: `${r.name} ${r.summary}`.trim(),
      metadata: { ...r },
      score: 0,
    }));
    const reranked = await rerank(query, forRerank, 5);
    return reranked
      .filter((r) => r.score >= 0.3)
      .map((r) => r.metadata as unknown as BangumiSearchResult);
  }

  return merged.slice(0, 6);
}

/**
 * searchWeb — 搜索 Bangumi 获取最新作品/角色信息。
 * 当用户问到知识库未收录的内容、冷门作品、新作时使用。
 * persist=true 时会在后台自动回填到知识库。
 */
export const searchWebTool = new DynamicStructuredTool({
  name: "searchWeb",
  description:
    "搜索 Bangumi 获取作品和角色信息。当用户问到知识库之外的内容、新作、冷门作品时使用。" +
    "当用户提到特定作品/角色/公司时，先用 getInformation 从知识库检索，如果找不到再用此工具搜索。",
  schema: z.object({
    query: z.string().describe("搜索关键词（作品名或角色名）"),
    persist: z.boolean().optional().default(false).describe(
      "是否将搜索结果持久化到知识库。仅当用户明确说'存一下''收录''保存到知识库'等时设为 true，平时保持默认 false",
    ),
  }),
  func: async ({ query, persist }) => {
    try {
      const results = await searchBangumi(query);
      // persist=true 时后台自动回填
      if (persist) {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
        for (const game of results.filter(r => r.type === 'game').slice(0, 2)) {
          fetch(`${baseUrl}/api/backfill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subjectId: game.id, name: game.name }),
          }).catch(() => {});
        }
      }
      return JSON.stringify(results);
    } catch (e) {
      return JSON.stringify({
        error: (e as Error).message,
        note: "Bangumi 搜索暂时不可用，请稍后重试",
      });
    }
  },
});

/**
 * disambiguateEntity — 模糊指代澄清。
 * 当用户提到的游戏名/角色名有歧义时反问用户确认。
 */
export const disambiguateEntityTool = new DynamicStructuredTool({
  name: "disambiguateEntity",
  description:
    "当用户指代模糊，无法确定具体是哪个游戏或角色时使用。反问用户确认具体实体，而不是自己猜测。",
  schema: z.object({
    entity: z.string().describe("用户说的模糊名称或指代"),
  }),
  func: async ({ entity }) => {
    return JSON.stringify({ action: "clarify", entity });
  },
});

/** 所有 Tool 的汇总数组 */
export const tools = [getInformationTool, rewriteQueryTool, searchWebTool, disambiguateEntityTool];

/** 预构建的 ToolNode，供 LangGraph 直接使用 */
export const toolNode = new ToolNode(tools);
