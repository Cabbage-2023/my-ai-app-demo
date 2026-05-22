/**
 * POST /api/backfill
 *
 * 接收 Agent 的回填请求，将 Bangumi 作品数据持久化到知识库。
 * Body: { subjectId: number, name?: string }
 *
 * 阻塞情况：
 *   Phase 1-4（API 拉取 + HTML 抓取 + 解析 + 分块）是同步的，会阻塞 HTTP 响应
 *   Phase 5（嵌入 + Qdrant 写入）是 fire-and-forget（不 await），不阻塞
 */
import { NextResponse } from 'next/server';
import { backfillBySubjectId } from '@/lib/ai/backfill';

export async function POST(req: Request) {
  try {
    const { subjectId, name }: { subjectId: number; name?: string } = await req.json();

    if (!subjectId || typeof subjectId !== 'number') {
      return NextResponse.json(
        { success: false, error: '缺少有效的 subjectId' },
        { status: 400 },
      );
    }

    const result = await backfillBySubjectId(subjectId, name);
    const httpStatus = result.status === 'accepted' ? 200 : 200; // 即使拒绝也返回 200，前端看 status 字段

    return NextResponse.json(result, { status: httpStatus });
  } catch (e) {
    console.error('/api/backfill error:', e);
    return NextResponse.json(
      { success: false, status: 'error', message: (e as Error).message },
      { status: 500 },
    );
  }
}
