import { ChatOpenAI } from "@langchain/openai";
import { type BaseMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { type RunnableConfig } from "@langchain/core/runnables";
import { tools } from "./tools";

/** LangGraph 中节点的 state 参数类型（与 graph.ts 的 Annotation.Root 对应） */
export interface AgentState {
  messages: BaseMessage[];
  context: string;
  tokenBudget: number;
}

/** 持久的 System Prompt — 指导 AI 助手的角色和行为 */
const SYSTEM_PROMPT = `你是一个精通 Galgame 领域的 AI 助手。

## 核心能力
- 你可以回答关于游戏剧情、角色、评价、制作团队等问题
- 当需要回忆知识库中的信息时，使用 getInformation 工具检索
- 对于对比类问题（比较多个游戏/角色），应分别检索再综合回答
- 答案应基于知识库内容，不确定的内容不要编造

## 检索规范
调用 getInformation 时，必须根据问题内容设置精确的过滤条件：
- 问题涉及**特定角色** → 必须设置 filter.charName（角色全名）
- 问题涉及**特定游戏** → 必须设置 filter.gameName（游戏全名或常见译名）
- 问题同时涉及角色和游戏 → 同时设置 charName 和 gameName
- 问题涉及**特定类型**（如"剧情"、"评价"等不作为过滤条件） → 按需设置 filter.type
- query 参数保持简洁，以实体名称为主，避免过长描述影响检索效果

## 行为准则
- 回答简洁有条理，优先使用中文
- 如果知识库中没有足够信息，如实告知用户
- 对于需要最新信息的提问，可以使用 searchWeb 工具

## 事实引用规范
- **检索结果优先于你的自有知识**。如果 getInformation 返回的内容与你记忆不符，以检索结果为准
- 不要在回答中混用检索结果和你自己的知识——如果要引用检索内容，确保完整引用，不被你自己的预设覆盖
- 如果你发现检索结果与你记忆矛盾，以检索结果为标准答案`;

/** 缓存模型实例，避免重复创建 */
let model: ReturnType<typeof createModel> | null = null

function createModel() {
  return new ChatOpenAI({
    model: "deepseek-v4-flash",
    apiKey: process.env.DEEPSEEK_API_KEY,
    temperature: 0,
    modelKwargs: {
      thinking: { type: "disabled" },
    },
    configuration: {
      baseURL: "https://api.deepseek.com",
    },
  }).bindTools(tools)
}

function getModel() {
  if (!model) model = createModel()
  return model
}

/**
 * agentNode — 核心决策节点。
 * 接收当前消息列表，调用 LLM（带 Tool binding），返回回复或 Tool 调用请求。
 */
export async function agentNode(
  state: AgentState,
  config?: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { messages } = state;

  // 如果只有一条 user 消息，在开头插入 system prompt
  const fullMessages: BaseMessage[] = messages.some(
    (m) => m._getType() === "system",
  )
    ? messages
    : [new SystemMessage(SYSTEM_PROMPT), ...messages];

  const response = await getModel().invoke(fullMessages, {
    signal: config?.signal,
  });

  return { messages: [response] };
}

/**
 * rewriteNode — 查询重写节点。
 * 对用户最新一条消息进行改写，提升 RAG 检索效果（消歧、补全、同义改写）。
 * 仅在特定条件下启用（例如路由判断需要重写时）。
 */
export async function rewriteNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg._getType() !== "human") {
    return {}; // 不是用户消息，跳过重写
  }

  const rewriteModel = new ChatOpenAI({
    model: "deepseek-v4-flash",
    apiKey: process.env.DEEPSEEK_API_KEY,
    temperature: 0.3,
    configuration: {
      baseURL: "https://api.deepseek.com",
    },
  });

  const response = await rewriteModel.invoke([
    new SystemMessage(
      "你是一个查询重写助手。将用户的问句改写得更适合检索，保持原意不变。" +
        "输出仅返回改写后的文本，不要加解释。",
    ),
    lastMsg,
  ]);

  // 用改写后的消息替换原消息
  const rewritten = new AIMessage({
    content: `[重写后的查询] ${response.content}`,
  });

  return { messages: [rewritten] };
}

/**
 * router — 条件边函数。
 * 根据 agent 的输出来决定下一步路由：
 * - 有 tool_calls → 走 "tools" 节点
 * - 没有 → 结束（"__end__"）
 */
export function router(state: AgentState): string {
  const lastMessage = state.messages[state.messages.length - 1];

  if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
    return "tools";
  }

  return "__end__";
}
