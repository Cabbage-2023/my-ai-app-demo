import { createUIMessageStreamResponse } from 'ai';
import type { UIMessage } from 'ai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { getAgent } from '@/lib/ai/langgraph/graph';
import { searchConversationMemories } from '@/lib/ai/memory';

/** 6 轮对话对应的消息数量阈值（6 user + 6 assistant） */
const COMPRESSION_THRESHOLD = 12;

/** 将 UIMessage[] 转为 LangChain BaseMessage[] */
function toLangChainMessages(msgs: UIMessage[]): BaseMessage[] {
  return msgs.map((m) => {
    const content = m.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('') ?? '';
    if (m.role === 'user') return new HumanMessage(content);
    if (m.role === 'assistant') return new AIMessage(content);
    return new HumanMessage(content);
  });
}

/** 将早期对话消息压缩为摘要 */
async function compressMessages(msgs: UIMessage[]): Promise<string> {
  const text = msgs
    .map((m) => {
      const role = m.role === 'user' ? '用户' : 'AI';
      const content = m.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('') ?? '';
      return `${role}: ${content}`;
    })
    .join('\n');

  const model = new ChatOpenAI({
    model: 'deepseek-v4-flash',
    apiKey: process.env.DEEPSEEK_API_KEY,
    temperature: 0.3,
    modelKwargs: {
      thinking: { type: 'disabled' },
    },
    configuration: { baseURL: 'https://api.deepseek.com' },
  });

  const response = await model.invoke([
    new SystemMessage(
      '将以下对话压缩为简洁的中文摘要，保留关键信息：讨论的游戏/角色名称、用户偏好、已获得的信息。直接输出摘要，不要加前缀。',
    ),
    new HumanMessage(text),
  ]);

  return typeof response.content === 'string'
    ? response.content
    : response.content.map((c) => ('text' in c ? c.text : '')).join('');
}

export async function POST(req: Request) {
  const { messages, conversationId }: {
    messages: UIMessage[];
    conversationId?: string;
  } = await req.json();

  // 超过阈值时压缩早期对话，保留最近 6 轮原始消息
  let langChainMessages: BaseMessage[];
  let compressedContext = '';

  if (messages.length > COMPRESSION_THRESHOLD) {
    const earlyMessages = messages.slice(0, messages.length - COMPRESSION_THRESHOLD);
    const recentMessages = messages.slice(-COMPRESSION_THRESHOLD);
    compressedContext = await compressMessages(earlyMessages);
    langChainMessages = toLangChainMessages(recentMessages);
  } else {
    langChainMessages = toLangChainMessages(messages);
  }

  // 检索相关的历史对话记忆，追加到 context
  const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
  if (lastUserMsg) {
    const lastText = lastUserMsg.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('') ?? '';
    if (lastText) {
      const memories = await searchConversationMemories(lastText, 3);
      if (memories) {
        compressedContext = compressedContext
          ? `${compressedContext}\n\n## 历史对话记忆\n${memories}`
          : `## 历史对话记忆\n${memories}`;
      }
    }
  }

  const agent = getAgent();
  const threadId = conversationId || crypto.randomUUID();

  // 后端中止：客户端断连时取消 agent 执行，避免 token 浪费
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => {
    abortController.abort();
  }, { once: true });

  const stream = new ReadableStream({
    cancel() {
      abortController.abort();
    },
    async start(controller) {
      // 在 try 外声明，供 catch 块访问
      let textId = '';
      let hasText = false;

      try {
        const eventStream = await agent.stream(
          { messages: langChainMessages, context: compressedContext },
          {
            configurable: { thread_id: threadId },
            streamMode: 'updates',
            signal: abortController.signal,
          },
        );

        // uimessage chunk 协议要求 text-start/delta/end 序列
        textId = crypto.randomUUID();

        for await (const event of eventStream) {
          if (abortController.signal.aborted) break;
          // ── agent 节点输出 ──
          if (event.agent) {
            const msg: AIMessage = event.agent.messages[0];
            const content = typeof msg.content === 'string' ? msg.content : '';

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
            if (!msg.tool_calls?.length && content) {
              if (!hasText) {
                controller.enqueue({ type: 'text-start' as const, id: textId });
                hasText = true;
              }
              controller.enqueue({ type: 'text-delta' as const, id: textId, delta: content });
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

          // ── respond 节点输出（兜底回复） ──
          if (event.respond) {
            const msg: AIMessage = event.respond.messages[0];
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (content) {
              if (!hasText) {
                controller.enqueue({ type: 'text-start' as const, id: textId });
                hasText = true;
              }
              controller.enqueue({ type: 'text-delta' as const, id: textId, delta: content });
            }
          }
        }

        if (hasText) {
          controller.enqueue({ type: 'text-end' as const, id: textId });
        }
        controller.enqueue({ type: 'finish' as const, finishReason: 'stop' as const });
      } catch (e) {
        const errMsg = (e as Error).message;
        const errName = (e as Error).name;
        const isAbort = errName === 'AbortError' || abortController.signal.aborted;

        if (isAbort) {
          if (hasText) controller.enqueue({ type: 'text-end' as const, id: textId });
          controller.enqueue({ type: 'finish' as const, finishReason: 'stop' as const });
          return;
        }

        const errId = crypto.randomUUID();
        controller.enqueue({ type: 'text-start' as const, id: errId });
        controller.enqueue({
          type: 'text-delta' as const,
          id: errId,
          delta: `抱歉，处理请求时出错：${errMsg}`,
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
