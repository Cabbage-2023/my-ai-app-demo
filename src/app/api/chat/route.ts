import { createUIMessageStreamResponse } from 'ai';
import type { UIMessage } from 'ai';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { getAgent } from '@/lib/ai/langgraph/graph';

/** 将 UIMessage[] 转为 LangChain BaseMessage[] */
function toLangChainMessages(msgs: UIMessage[]): BaseMessage[] {
  return msgs.map((m) => {
    const content = m.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    if (m.role === 'user') return new HumanMessage(content);
    if (m.role === 'assistant') return new AIMessage(content);
    return new HumanMessage(content);
  });
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const langChainMessages = toLangChainMessages(messages.slice(-6));

  const agent = getAgent();
  const threadId = crypto.randomUUID();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const eventStream = await agent.stream(
          { messages: langChainMessages },
          { configurable: { thread_id: threadId }, streamMode: 'updates' },
        );

        // uimessage chunk 协议要求 text-start → text-delta → text-end 序列
        const textId = crypto.randomUUID();
        let hasText = false;

        for await (const event of eventStream) {
          // ── agent 节点输出 ──
          if (event.agent) {
            const msg: AIMessage = event.agent.messages[0];

            // 有 tool_calls → 发射 tool-input-available（前端渲染 loading 卡片）
            if (msg.tool_calls?.length) {
              for (const tc of msg.tool_calls) {
                controller.enqueue({
                  type: 'tool-input-available' as const,
                  toolCallId: tc.id!,
                  toolName: tc.name,
                  input: tc.args,
                });
              }
            }

            // 有文本内容 → text-start / text-delta
            // 注意：只在 agent 没有 tool_calls 时 emit 文本。
            // 有 tool_calls 的 agent 事件中的文本是调用工具前的"思考过程"（如"让我检索一下"），
            // 如果也 emit 会导致工具卡片穿插在文本中间，打乱对话顺序。
            if (!msg.tool_calls?.length && typeof msg.content === 'string' && msg.content) {
              if (!hasText) {
                controller.enqueue({ type: 'text-start' as const, id: textId });
                hasText = true;
              }
              controller.enqueue({ type: 'text-delta' as const, id: textId, delta: msg.content });
            }
          }

          // ── tools 节点输出（tool 执行结果） ──
          if (event.tools) {
            const toolMessages: { tool_call_id: string; content: string }[] =
              event.tools.messages ?? [];

            for (const tm of toolMessages) {
              let output: unknown;
              try {
                output = JSON.parse(tm.content);
              } catch {
                output = tm.content;
              }
              controller.enqueue({
                type: 'tool-output-available' as const,
                toolCallId: tm.tool_call_id,
                output,
              });
            }
          }
        }

        if (hasText) {
          controller.enqueue({ type: 'text-end' as const, id: textId });
        }
        controller.enqueue({ type: 'finish' as const, finishReason: 'stop' as const });
      } catch (e) {
        const errId = crypto.randomUUID();
        controller.enqueue({ type: 'text-start' as const, id: errId });
        controller.enqueue({
          type: 'text-delta' as const,
          id: errId,
          delta: `抱歉，处理请求时出错：${(e as Error).message}`,
        });
        controller.enqueue({ type: 'text-end' as const, id: errId });
        controller.enqueue({ type: 'finish' as const, finishReason: 'error' as const });
      } finally {
        controller.close();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
