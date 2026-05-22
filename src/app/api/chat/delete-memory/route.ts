import { NextResponse } from 'next/server';
import { deleteConversationMemory } from '@/lib/qdrant';

/**
 * POST /api/chat/delete-memory
 *
 * 删除某条对话在 Qdrant 中的记忆 points。由前端在删除对话时触发。
 * Body: { conversationId: string }
 */
export async function POST(req: Request) {
  try {
    const { conversationId }: { conversationId: string } = await req.json();

    if (!conversationId) {
      return NextResponse.json({ success: false, error: '缺少 conversationId' }, { status: 400 });
    }

    await deleteConversationMemory(conversationId);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('delete-memory error:', e);
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
}
