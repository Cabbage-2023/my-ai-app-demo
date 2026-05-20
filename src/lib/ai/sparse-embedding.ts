/**
 * 轻量级稀疏向量生成器（BM25 风格）
 *
 * 对文本进行 tokenize → hash 映射索引 → TF 权重，生成 Qdrant 兼容的稀疏向量。
 * 不需要任何外部模型下载或 ONNX runtime。
 *
 * 稀疏向量格式：{ indices: number[], values: number[] }
 *   - indices: token 的 hash 索引（24-bit 空间，约 1600 万）
 *   - values: 归一化词频权重 [0, 1]
 */

// 匹配中文单字、英文单词、数字
const TOKEN_RE = /[一-鿿]|[a-zA-Z]+|[0-9]+/g;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    tokens.push(match[0].toLowerCase());
  }
  return tokens;
}

/** Jenkins 一次 hash，将字符串映射到 24-bit 空间 (0 ~ 16,777,215) */
function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash << 5) - hash + token.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) & 0xffffff;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

/**
 * 为一段文本生成稀疏向量（BM25 风格 token 频率）。
 * 查询和文档共用此函数（Qdrant 在 search 侧自动处理 scoring）。
 */
export function generateSparseEmbedding(text: string): SparseVector {
  const tokens = tokenize(text);
  const freq = new Map<number, number>();
  for (const token of tokens) {
    const idx = hashToken(token);
    freq.set(idx, (freq.get(idx) || 0) + 1);
  }

  const indices: number[] = [];
  const values: number[] = [];

  const maxFreq = Math.max(...freq.values(), 1);
  for (const [idx, count] of freq) {
    indices.push(idx);
    // 对数 TF 归一化: log(1 + count) / log(1 + maxFreq)
    values.push(Math.log(1 + count) / Math.log(1 + maxFreq));
  }

  return { indices, values };
}
