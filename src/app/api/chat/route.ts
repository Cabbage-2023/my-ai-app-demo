import { createUIMessageStreamResponse } from 'ai';
import type { UIMessage } from 'ai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { getAgent } from '@/lib/ai/langgraph/graph';
import { saveSingleQAPair } from '@/lib/ai/memory';
import { setConversationId } from '@/lib/ai/langgraph/tools';

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

  const agent = getAgent();
  const threadId = conversationId || crypto.randomUUID();

  // 设置 conversationId，供 searchConversationMemory tool 使用
  setConversationId(threadId);

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
      let fullAssistantText = '';

      const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

      // 将文本分批推送，每批之间留出延迟让浏览器渲染，防止主线程卡死
      async function streamText(text: string) {
        const id = crypto.randomUUID();
        controller.enqueue({ type: 'text-start' as const, id });
        const BATCH = 5;
        const DELAY = 12;
        for (let i = 0; i < text.length; i += BATCH) {
          if (abortController.signal.aborted) break;
          controller.enqueue({ type: 'text-delta' as const, id, delta: text.slice(i, i + BATCH) });
          await sleep(DELAY);
        }
        if (!abortController.signal.aborted) {
          controller.enqueue({ type: 'text-end' as const, id });
        }
      }

      try {
        // streamMode: 'updates' — 图执行完整的非流式路径，工具调用不受影响
        const eventStream = await agent.stream(
          { messages: langChainMessages, context: compressedContext },
          {
            configurable: { thread_id: threadId },
            streamMode: 'updates',
            signal: abortController.signal,
          },
        );

        for await (const event of eventStream) {
          if (abortController.signal.aborted) break;

          // agent 节点输出
          if (event.agent) {
            const msg: AIMessage = event.agent.messages[0];
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
            const agentText = typeof msg.content === 'string' ? msg.content : '';
            if (agentText) {
              fullAssistantText += agentText;
              await streamText(agentText);
            }
          }

          // tools 节点输出
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

          // respond 节点输出（兜底回复）
          if (event.respond) {
            const msg = event.respond.messages[0];
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (text) {
              fullAssistantText += text;
              await streamText(text);
            }
          }
        }

        controller.enqueue({ type: 'finish' as const, finishReason: 'stop' as const });

        if (fullAssistantText && threadId) {
          const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
          if (lastUserMsg) {
            const userText = lastUserMsg.parts
              ?.filter((p: any) => p.type === 'text')
              .map((p: any) => p.text ?? '')
              .join('') ?? '';
            if (userText) {
              saveSingleQAPair(threadId, userText, fullAssistantText)
                .catch((e) => console.error('save memory error:', e));
            }
          }
        }
      } catch (e) {
        const errMsg = (e as Error).message;
        const errName = (e as Error).name;
        const isAbort = errName === 'AbortError' || abortController.signal.aborted;

        if (isAbort) {
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
