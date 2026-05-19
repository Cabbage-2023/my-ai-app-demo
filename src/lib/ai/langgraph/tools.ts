import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { generateEmbedding } from "@/lib/ai/embedding";
import { searchSimilar } from "@/lib/qdrant";
import { rerank } from "@/lib/ai/reranker";

/**
 * getInformation — 从 Qdrant 知识库中检索与问题相关的信息。
 * 语义同 route.ts 中已有 tool，但封装为 LangChain DynamicStructuredTool 供 LangGraph 使用。
 */
export const getInformationTool = new DynamicStructuredTool({
  name: "getInformation",
  description:
    "从知识库中检索与问题相关的信息。当你需要回忆知识库内容时调用。" +
    "对于对比类问题（比较多个游戏/角色），应使用 filter.type 缩小范围；" +
    "对于特定游戏的问题，应使用 filter.gameName 精确定位。",
  schema: z.object({
    question: z.string().describe("要检索的问题"),
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
  func: async ({ question, filter: inputFilter }) => {
    const embedding = await generateEmbedding(question);

    let qdrantFilter: Record<string, unknown> | undefined;
    if (inputFilter) {
      const must: Record<string, any>[] = [];
      const should: Record<string, any>[] = [];

      if (typeof inputFilter.type === "string") {
        must.push({ key: "type", match: { value: inputFilter.type } });
      } else if (Array.isArray(inputFilter.type)) {
        for (const t of inputFilter.type) {
          should.push({ key: "type", match: { value: t } });
        }
      }

      // 对照 evaluate.ts 的 min_should 策略：同时匹配正式名和别名字段
      const nameConditions: Record<string, any>[] = [];
      if (inputFilter.gameName) {
        nameConditions.push(
          { key: "gameName", match: { value: inputFilter.gameName } },
          { key: "gameAliases", match: { value: inputFilter.gameName } },
        );
      }
      if (inputFilter.charName) {
        nameConditions.push(
          { key: "charName", match: { value: inputFilter.charName } },
          { key: "charNameCN", match: { value: inputFilter.charName } },
          { key: "charAliases", match: { value: inputFilter.charName } },
        );
      }
      if (nameConditions.length > 0) {
        must.push({ min_should: { conditions: nameConditions, min_count: 1 } });
      }

      if (must.length > 0 || should.length > 0) {
        qdrantFilter = {};
        if (must.length > 0) qdrantFilter.must = must;
        if (should.length > 0) qdrantFilter.should = should;
      }
    }

    // 粗召回 top 20 → rerank 精排 → 返回 top 5
    const rawResults = await searchSimilar(embedding, 20, qdrantFilter as any);
    const reranked = await rerank(question, rawResults, 5);

    // 置信度阈值：maxScore < 0.4 时不展示知识库卡片，LLM 自行 fallback
    const maxScore = reranked.length > 0
      ? Math.max(...reranked.map((r) => r.score))
      : 0;
    if (maxScore > 0 && maxScore < 0.4) return JSON.stringify([]);

    return JSON.stringify(
      reranked.map((r) => ({
        content: r.content,
        metadata: { ...r.metadata, score: r.score },
      })),
    );
  },
});

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

/**
 * searchWeb — 搜索网络获取最新信息（占位，后续接入真实搜索 API）。
 */
export const searchWebTool = new DynamicStructuredTool({
  name: "searchWeb",
  description:
    "搜索网络获取最新信息。当用户问到时效性强、知识库之外的内容时使用，比如业界新闻、新作信息。",
  schema: z.object({
    query: z.string().describe("搜索关键词"),
  }),
  func: async ({ query }) => {
    // TODO: 接入真实搜索引擎（Tavily / Bing Search / SerpAPI）
    return JSON.stringify({
      note: "searchWeb 功能尚未接入真实搜索 API，以下为占位回复",
      query,
    });
  },
});

/** 所有 Tool 的汇总数组 */
export const tools = [getInformationTool, rewriteQueryTool, searchWebTool];

/** 预构建的 ToolNode，供 LangGraph 直接使用 */
export const toolNode = new ToolNode(tools);
