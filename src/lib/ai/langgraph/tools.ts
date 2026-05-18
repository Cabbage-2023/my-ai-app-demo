import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { generateEmbedding } from "@/lib/ai/embedding";
import { searchSimilar, type QdrantCondition } from "@/lib/qdrant";

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
      const must: QdrantCondition[] = [];
      const should: QdrantCondition[] = [];

      if (typeof inputFilter.type === "string") {
        must.push({ key: "type", match: { value: inputFilter.type } });
      } else if (Array.isArray(inputFilter.type)) {
        for (const t of inputFilter.type) {
          should.push({ key: "type", match: { value: t } });
        }
      }
      if (inputFilter.gameName) {
        must.push({ key: "gameName", match: { value: inputFilter.gameName } });
      }
      if (inputFilter.charName) {
        must.push({ key: "charName", match: { value: inputFilter.charName } });
      }

      if (must.length > 0 || should.length > 0) {
        qdrantFilter = {};
        if (must.length > 0) qdrantFilter.must = must;
        if (should.length > 0) qdrantFilter.should = should;
      }
    }

    const results = await searchSimilar(embedding, 3, qdrantFilter as any);
    return JSON.stringify(results.map((r) => ({ content: r.content, metadata: r.metadata })));
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
export const tools = [getInformationTool, searchWebTool];

/** 预构建的 ToolNode，供 LangGraph 直接使用 */
export const toolNode = new ToolNode(tools);
