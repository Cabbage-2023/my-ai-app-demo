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
- 对于知识库未收录的内容、新作、冷门作品，使用 searchWeb 工具从 Bangumi 搜索

### 检索顺序
1. 先调 getInformation 从知识库检索
2. 信息不足时再调 searchWeb 联网搜索

### searchWeb 的 persist 参数
searchWeb 工具带有 persist 参数（默认 false）：
- 用户只是问信息 → persist=false（默认），仅搜索展示，不存库
- 用户明确说"存一下""收录""保存到知识库"等 → persist=true，搜完后自动后台入库

**注意：除非用户明确提到多个游戏且关系非常确定（如"把 XX 和 YY 都存了"），否则 persist=true 一次只存一个游戏。搜索结果可能包含系列相关作品，不要因为搜到了就批量入库。**

## 历史对话记忆
使用 searchConversationMemory 工具搜索当前对话中之前讨论过的内容。当你觉得用户可能是在延续之前的话题、或者想回忆之前提到过的某个角色/作品时调用。搜索词以关键实体名称为主，不要用完整句子。

## 事实引用规范
- **检索结果优先于你的自有知识**。如果 getInformation 返回的内容与你记忆不符，以检索结果为准
- 不要在回答中混用检索结果和你自己的知识——如果要引用检索内容，确保完整引用，不被你自己的预设覆盖
- 如果你发现检索结果与你记忆矛盾，以检索结果为标准答案

## 步数控制
在发起任何工具调用之前，先问自己：
1. 我是否已经收集到足够的信息来回答用户？
2. 还有未完成的子任务需要继续查询吗？
3. 用户指代是否模糊？如果是，先用 disambiguateEntity 反问用户确认具体实体，而不是自己猜测
如果信息已充足或知识库中没有更多相关内容，直接生成回复，不要重复调用工具。

## 兜底规则
如果你已经尝试过 getInformation（知识库）和 searchWeb（联网搜索），两者都没有返回有效信息——说明知识库和 Bangumi 都没有收录这个内容。此时直接用你自己的知识回答，**不要重复调用工具**。不确定的内容如实告知用户。`;

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
  const { messages, context } = state;

  let systemContent = SYSTEM_PROMPT;
  if (context) {
    systemContent += `\n\n## 历史对话摘要\n以下是当前对话之前的内容摘要，请参考这些信息：\n${context}`;
  }

  const baseMessages: BaseMessage[] = messages.some(
    (m) => m._getType() === "system",
  )
    ? messages
    : [new SystemMessage(systemContent), ...messages];

  // 去掉孤立 tool_calls（有 tool_calls 但无后续 tool 响应），防止 state 污染后报错
  const fullMessages: BaseMessage[] = [];
  for (let i = 0; i < baseMessages.length; i++) {
    const msg = baseMessages[i];
    if (msg instanceof AIMessage && (msg as AIMessage).tool_calls?.length) {
      const next = baseMessages[i + 1];
      if (!next || next._getType() !== "tool") continue;
    }
    fullMessages.push(msg);
  }

  // 节点保持原子性：用 invoke() 而非 stream()，流式输出由 LangGraph 图层面的 streamMode: "messages" 处理
  const response = await getModel().invoke(fullMessages, {
    signal: config?.signal,
  });

  if (response.tool_calls?.length) {
    console.log(`[agent] 决策: tool_calls=${response.tool_calls.map(t => `${t.name}(${JSON.stringify(t.args)})`).join(', ')}`);
  } else {
    const text = typeof response.content === 'string' ? response.content.slice(0, 100) : '(非文本)';
    console.log(`[agent] 决策: 直接回复 "${text}..."`);
  }

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
    modelKwargs: {
      thinking: { type: "disabled" },
    },
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
 * respondNode — 兜底回复节点。
 * 当 tool_calls 次数达到上限时触发，不再调用工具，
 * 让 LLM 基于已有信息（或自身知识）生成最终回复。
 */
export async function respondNode(
  state: AgentState,
  config?: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { messages, context } = state;

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

  let systemContent =
    "你已经尝试过检索知识库和联网搜索，都没有找到足够的信息。请基于你自己的知识回答用户的问题。如果不知道，如实告知用户。回答简洁有条理，优先使用中文。";
  if (context) {
    systemContent += `\n\n## 历史对话摘要\n${context}`;
  }

  // 剥离所有 tool 相关消息（带 tool_calls 的 AIMessage + ToolMessage）
  // 兜底模型没有绑定 tools，历史中出现 tool_calls 会导致 DeepSeek API 报错
  const cleanMessages = messages.filter((m) => {
    if (m._getType() === "system") return false;
    if (m instanceof AIMessage && (m as AIMessage).tool_calls?.length) return false;
    if (m._getType() === "tool") return false;
    return true;
  });

  // 节点保持原子性：用 invoke()，流式输出由 LangGraph 图层面的 streamMode: "messages" 处理
  const response = await model.invoke([
    new SystemMessage(systemContent),
    ...cleanMessages,
  ]);

  return { messages: [response] };
}

/**
 * router — 条件边函数。
 * 根据 agent 的输出来决定下一步路由：
 * - 有 tool_calls → 走 "tools" 节点
 * - 没有 → 结束（"__end__"）
 *
 * 硬性限制：tool_calls 总次数 ≥ 8 时走 "respond" 兜底节点，防死循环。
 */
export function router(state: AgentState): string {
  const lastMessage = state.messages[state.messages.length - 1];

  // 统计历史 tool_calls 次数，超过上限走兜底回复
  const toolCallCount = state.messages.filter(
    (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length,
  ).length;
  if (toolCallCount >= 5) {
    console.log(`[router] 工具调用已达 ${toolCallCount} 次，转入兜底节点`);
    return "respond";
  }

  if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
    return "tools";
  }

  return "__end__";
}
