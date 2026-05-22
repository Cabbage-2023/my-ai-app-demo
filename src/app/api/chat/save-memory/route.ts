import { NextResponse } from 'next/server';
import { type UIMessage } from 'ai';
import { saveConversationMemory } from '@/lib/ai/memory';

/**
 * POST /api/chat/save-memory
 *
 * 保存对话记忆。由前端在对话结束时触发（beforeunload / 30min 超时 / 新建对话）。
 * Body: { conversationId: string, messages: UIMessage[] }
 */
export async function POST(req: Request) {
  try {
    const { conversationId, messages }: {
      conversationId: string;
      messages: UIMessage[];
    } = await req.json();

    if (!conversationId || !messages?.length) {
      return NextResponse.json({ success: false, error: '缺少 conversationId 或 messages' }, { status: 400 });
    }

    // 异步存储，不阻塞响应
    await saveConversationMemory(conversationId, messages);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('save-memory error:', e);
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
}

