import {
  StateGraph,
  Annotation,
  START,
  END,
  messagesStateReducer,
} from "@langchain/langgraph";
import { type BaseMessage } from "@langchain/core/messages";
import { agentNode, router, respondNode } from "./nodes";
import { toolNode } from "./tools";
import { createCheckpointer } from "./memory";

// ── State 定义 ───────────────────────────────────────

/**
 * AgentState — LangGraph 的状态标注。
 *
 * - messages:    对话消息列表，使用 LangGraph 内置的 messagesStateReducer
 *                自动将新消息追加到末尾
 * - context:     检索上下文累积，每次 tool 返回结果后追加
 * - tokenBudget: 本次 session 的 token 预算，用尽后停止 Agent 循环
 */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  context: Annotation<string>({
    reducer: (prev: string | undefined, next: string | undefined) => {
      if (!next) return prev ?? "";
      return prev ? `${prev}\n\n${next}` : next;
    },
    default: () => "",
  }),
  tokenBudget: Annotation<number>({
    reducer: (_prev: number | undefined, next: number | undefined) =>
      next ?? 0,
    default: () => 2000,
  }),
});

// ── Graph 构建 ───────────────────────────────────────

/** 编译后的 LangGraph Agent（类型由 compile() 推断） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compiledGraph: any = null;

/**
 * getAgent — 获取（或创建）编译后的 LangGraph Agent 单例。
 * 多次调用返回同一实例，避免每次请求重复编译。
 *
 * 使用场景：在 route.ts 中 import 后直接调用 getAgent()，
 * 然后通过 agent.invoke({ messages: [...] }) 或 agent.stream() 驱动。
 */
export function getAgent() {
  if (compiledGraph) return compiledGraph;

  const builder = new StateGraph(AgentState)
    // 注册节点
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("respond", respondNode)
    // 入口 → agent
    .addEdge(START, "agent")
    // agent → 条件路由（工具调用继续 / 兜底 / 结束）
    .addConditionalEdges("agent", router, {
      tools: "tools",
      respond: "respond",
      __end__: END,
    })
    // tools → 回到 agent（继续循环）
    .addEdge("tools", "agent")
    // respond → 结束
    .addEdge("respond", END);

  compiledGraph = builder.compile({
    checkpointer: createCheckpointer(),
  });

  return compiledGraph;
}
