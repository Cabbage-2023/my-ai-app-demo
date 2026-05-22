/**
 * 长期会话记忆管理
 *
 * QA 对原文直存模式：将对话按 QA 对分拆，直接存储到 Qdrant conversation_memory collection，
 * 不做 LLM 摘要。搜索时使用 dense + sparse 混合搜索（RRF 合并）。
 *
 * 使用方式：
 * - 保存：route.ts 中 stream 结束后调用 saveSingleQAPair()
 * - 搜索：LangGraph agent 通过 searchConversationMemory tool 调用
 */

import { type UIMessage } from 'ai';
import { generateEmbedding } from '@/lib/ai/embedding';
import { generateSparseEmbedding } from '@/lib/ai/sparse-embedding';
import {
  ensureConversationMemoryCollection,
  upsertMemoryPoint,
  searchConversationMemoryHybrid,
} from '@/lib/qdrant';

/** 保存单个 QA 对到 Qdrant（由 route.ts 在 stream 结束后调用） */
export async function saveSingleQAPair(
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!conversationId || !userText || !assistantText) return

  await ensureConversationMemoryCollection()

  const text = `用户: ${userText}\nAI: ${assistantText}`
  const [dense, sparse] = await Promise.all([
    generateEmbedding(text),
    Promise.resolve(generateSparseEmbedding(text)),
  ])

  await upsertMemoryPoint(
    dense,
    {
      conversationId,
      qaId: `${conversationId}-${Date.now()}`,
      userMessage: userText,
      assistantMessage: assistantText,
      userId: 'default',
      createdAt: Date.now(),
    },
    { bm25: sparse },
  )
}

/** 保存整段对话的所有 QA 对到 Qdrant（兼容旧格式，供 save-memory API 使用） */
export async function saveConversationMemory(
  conversationId: string,
  messages: UIMessage[],
): Promise<void> {
  if (messages.length < 2) return

  await ensureConversationMemoryCollection()

  let lastUserText = ''
  let lastAssistantText = ''

  for (const msg of messages) {
    const text = msg.parts
      ?.filter((p: any) => p.type === 'text')
      .map((p: any) => p.text ?? '')
      .join('') ?? ''

    if (msg.role === 'user') {
      // 如果已经有上一对没保存的 user+assistant，先存
      if (lastUserText && lastAssistantText) {
        await saveSingleQAPair(conversationId, lastUserText, lastAssistantText)
        lastAssistantText = ''
      }
      lastUserText = text
    } else if (msg.role === 'assistant' && lastUserText) {
      lastAssistantText = text
      await saveSingleQAPair(conversationId, lastUserText, lastAssistantText)
      lastUserText = ''
      lastAssistantText = ''
    }
  }
}

/** 搜索当前对话的历史记忆（按 conversationId 过滤） */
export async function searchConversationMemories(
  query: string,
  conversationId?: string,
  limit = 3,
): Promise<string> {
  const [dense, sparse] = await Promise.all([
    generateEmbedding(query),
    Promise.resolve(generateSparseEmbedding(query)),
  ])

  const results = await searchConversationMemoryHybrid(dense, sparse, limit, conversationId)
  if (results.length === 0) return ''

  return results
    .map((r, i) => `${i + 1}. ${r.content}`)
    .join('\n')
}
