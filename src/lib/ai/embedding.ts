import { embed, embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const siliconflow = createOpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
});

const embeddingModel = siliconflow.embedding('BAAI/bge-m3');

// generateEmbedding — 单个文本转向量
export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: embeddingModel,
    value: text,
  });
  return embedding;
}

// generateEmbeddings — 批量文本转向量（后面初始化知识库时用）
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: texts,
  });
  return embeddings;
}