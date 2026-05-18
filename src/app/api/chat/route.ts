import { streamText, UIMessage, tool, stepCountIs } from 'ai';
import { deepseek } from '@ai-sdk/deepseek';
import { z } from 'zod';
import connectDB from '@/lib/mongodb';
import { Resource } from '@/lib/models/resource';
import { generateEmbedding } from '@/lib/ai/embedding';
import { searchSimilar, upsertPoint } from '@/lib/qdrant';

/**
 * 将 UIMessage[]（parts 格式）转为 streamText 接受的 { role, content } 格式。
 * AI SDK v6 的 UIMessage 没有 content 字段（只有 parts），
 * 而 streamText 的 messages 参数要求 content 字段。
 */
function toSimpleMessages(msgs: UIMessage[]): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  return msgs.map(m => ({
    role: m.role,
    content: m.parts?.map(p => (p as any).text ?? '').join('') ?? '',
  }));
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: deepseek('deepseek-v4-flash'),
    messages: toSimpleMessages(messages.slice(-6)),// 只保留最近 6 条消息，防止对话久了以后雪球滚太大
    stopWhen: stepCountIs(3),// 3步后停止，这样就可以调用tool的时候，也能看到ai说话了
    tools: {
      weather: tool({
        description: 'Get the weather in a location (fahrenheit)',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          const temperature = Math.round(Math.random() * (90 - 32) + 32);
          return {
            location,
            temperature,
          };
        },
      }),

      convertFahrenheitToCelsius: tool({
        description: 'Convert a temperature in fahrenheit to celsius',
        inputSchema: z.object({
          temperature: z
            .number()
            .describe('The temperature in fahrenheit to convert'),
        }),
        execute: async ({ temperature }) => {
          const celsius = Math.round((temperature - 32) * (5 / 9));
          return {
            celsius,
          };
        },
      }),
    
      // --- 以下是 RAG 知识库的 tool ---
      addResource: tool({
        description: '向知识库添加一条信息。调用前确认这条信息是不重复的、有价值的',
        inputSchema: z.object({
          content: z.string().describe('要存入的文本内容'),
          metadata: z.record(z.string(), z.any()).describe('附加信息，如 { name, source, type, tags }'),
        }),
        execute: async ({ content, metadata }) => {
          await connectDB();
          const embedding = await generateEmbedding(content);
          await Resource.create({ content, embedding, metadata });
          await upsertPoint(embedding, { content, ...metadata });
          return { success: true, message: '已存入知识库' };
        },
      }),

      getInformation: tool({
        description: '从知识库中检索与问题相关的信息。当你需要回忆知识库内容时调用。'
          + '对于对比类问题（比较多个游戏/角色），应使用 filter.type=["game_intro"] 缩小范围；'
          + '对于特定游戏的问题，应使用 filter.gameName 精确定位',
        inputSchema: z.object({
          question: z.string().describe('要检索的问题'),
          filter: z.object({
            type: z.union([z.string(), z.array(z.string())]).optional()
              .describe('过滤类型：单个类型用字符串，多个类型用数组（OR 语义）'),
            gameName: z.string().optional().describe('游戏名称（精确匹配）'),
            charName: z.string().optional().describe('角色名称（精确匹配）'),
          }).optional().describe('检索过滤条件（可选），用于缩小检索范围'),
        }),
        execute: async ({ question, filter: inputFilter }) => {
          const embedding = await generateEmbedding(question);

          // 转换 filter 格式
          let qdrantFilter: import('@/lib/qdrant').QdrantFilter | undefined
          if (inputFilter) {
            const must: import('@/lib/qdrant').QdrantCondition[] = []
            const should: import('@/lib/qdrant').QdrantCondition[] = []

            if (typeof inputFilter.type === 'string') {
              must.push({ key: 'type', match: { value: inputFilter.type } })
            } else if (Array.isArray(inputFilter.type)) {
              for (const t of inputFilter.type) {
                should.push({ key: 'type', match: { value: t } })
              }
            }
            if (inputFilter.gameName) {
              must.push({ key: 'gameName', match: { value: inputFilter.gameName } })
            }
            if (inputFilter.charName) {
              must.push({ key: 'charName', match: { value: inputFilter.charName } })
            }

            if (must.length > 0 || should.length > 0) {
              qdrantFilter = {}
              if (must.length > 0) qdrantFilter.must = must
              if (should.length > 0) qdrantFilter.should = should
            }
          }

          const results = await searchSimilar(embedding, 3, qdrantFilter);
          return results.map(r => ({ content: r.content, metadata: r.metadata }));
        },
      }),
    },

    //这是一个回调函数，每当 AI 完成一个“步骤”（无论这一步是说话还是调工具）时都会触发。
    //由于工具执行是在后端发生的，前端有时候看不清细节。通过这个 console.log，
    //你可以在服务器终端（Terminal）里清楚地看到 AI 每一轮拿到了什么数据。
    onStepFinish: ({ toolResults }) => {
      console.log(toolResults);
    },
  });

  return result.toUIMessageStreamResponse();
}