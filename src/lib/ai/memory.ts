/**
 * 长期会话记忆管理
 *
 * 负责将对话总结存储到 Qdrant conversation_memory collection，
 * 以及在新对话中检索相关的历史记忆。
 */

import { type UIMessage } from 'ai';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { generateEmbedding } from '@/lib/ai/embedding';
import {
  ensureConversationMemoryCollection,
  upsertMemoryPoint,
  searchConversationMemory,
} from '@/lib/qdrant';

/** 保存一条对话记忆 */
export async function saveConversationMemory(
  conversationId: string,
  messages: UIMessage[],
): Promise<void> {
  // 至少要有 2 条消息才值得存
  if (messages.length < 2) return;

  // 1. 确保 collection 存在
  await ensureConversationMemoryCollection();

  // 2. 将消息序列化为文本
  const text = messages
    .map((m) => {
      const role = m.role === 'user' ? '用户' : 'AI';
      const content =
        m.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('') ?? '';
      return `${role}: ${content}`;
    })
    .join('\n');

  // 3. LLM 总结
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
      '你是一个对话摘要助手。将以下对话总结为简洁的中文摘要，并提取标签和关键事实。' +
      '按以下 JSON 格式输出，不要加多余内容：\n' +
      '{"summary": "对话摘要（2-3句话）", "tags": ["标签1", "标签2"], "keyFacts": ["关键事实1", "关键事实2"]}',
    ),
    new HumanMessage(text),
  ]);

  const content = typeof response.content === 'string'
    ? response.content
    : response.content.map((c) => ('text' in c ? c.text : '')).join('');

  // 4. 解析 LLM 输出
  let parsed: { summary: string; tags: string[]; keyFacts: string[] };
  try {
    // 清理可能的 Markdown 代码块包裹
    const clean = content.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    parsed = JSON.parse(clean);
  } catch {
    // 解析失败时用整个文本作为摘要
    parsed = { summary: content.slice(0, 500), tags: [], keyFacts: [] };
  }

  // 5. 生成 embedding
  const embedding = await generateEmbedding(parsed.summary);

  // 6. 写入 Qdrant
  const now = Date.now();
  await upsertMemoryPoint(embedding, {
    conversationId,
    summary: parsed.summary,
    tags: parsed.tags,
    keyFacts: parsed.keyFacts,
    messageCount: messages.length,
    createdAt: now,
    updatedAt: now,
  });
}

/** 搜索与当前查询相关的历史对话记忆 */
export async function searchConversationMemories(
  query: string,
  limit = 3,
): Promise<string> {
  const embedding = await generateEmbedding(query);
  const results = await searchConversationMemory(embedding, limit);

  if (results.length === 0) return '';

  return results
    .map((r, i) => {
      const tags = (r.metadata.tags as string[])?.length
        ? `[${(r.metadata.tags as string[]).join(', ')}]`
        : '';
      return `${i + 1}. ${r.content} ${tags}`;
    })
    .join('\n');
}
