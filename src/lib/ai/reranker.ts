interface RerankResult {
  index: number
  relevance_score: number
  document: { text: string }
}

interface RerankResponse {
  id: string
  results: RerankResult[]
}

interface DocumentItem {
  content: string
  metadata: Record<string, unknown>
  score: number
}

/**
 * rerank — 调用 SiliconFlow Rerank API 对候选文档精排。
 * 输入 query + 候选文档列表，返回按 relevance_score 降序排列的前 topN 条。
 * 若 API 调用失败，降级返回原始顺序的前 topN 条。
 */
export async function rerank(
  query: string,
  documents: DocumentItem[],
  topN = 5,
): Promise<DocumentItem[]> {
  if (documents.length === 0) return []
  if (documents.length === 1) return documents

  const apiKey = process.env.SILICONFLOW_API_KEY
  if (!apiKey) {
    console.warn('[reranker] SILICONFLOW_API_KEY not set, skipping rerank')
    return documents.slice(0, topN)
  }

  try {
    const res = await fetch('https://api.siliconflow.cn/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'BAAI/bge-reranker-v2-m3',
        query,
        documents: documents.map((d) => d.content),
        top_n: topN,
        return_documents: true,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[reranker] API error ${res.status}: ${text}`)
      return documents.slice(0, topN)
    }

    const data: RerankResponse = await res.json()

    return data.results.map((r) => ({
      ...documents[r.index],
      score: r.relevance_score,
    }))
  } catch (e) {
    console.error('[reranker] fetch failed:', e)
    return documents.slice(0, topN)
  }
}
