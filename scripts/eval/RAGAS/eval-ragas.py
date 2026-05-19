"""
RAGAS 评估脚本 — 数据评估 Step 2

stdin 读入 JSON → 计算 RAGAS 指标 → stdout 输出 JSON

输入格式：
{
  "questions": ["q1", "q2", ...],
  "answers": ["a1", "a2", ...],
  "contexts": [["ctx1a", "ctx1b"], ["ctx2a"], ...],
  "references": ["ref1", "ref2", ...]
}

输出格式：
{
  "scores": { "faithfulness": [...], "answer_relevancy": [...], "context_recall": [...] },
  "aggregate": { ... }
}
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
from datasets import Dataset

# 加载 .env
_env_path = Path(__file__).resolve().parents[3] / '.env'
if _env_path.exists():
    with open(_env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

# 确保 stdin 以 UTF-8 读取（Windows GBK 兼容）
if sys.stdin.encoding != 'utf-8':
    sys.stdin.reconfigure(encoding='utf-8')


def run_ragas(input_data: dict) -> dict:
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    from ragas.llms import LangchainLLMWrapper
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas import evaluate
    from ragas.metrics import faithfulness, answer_relevancy, context_recall

    # --- LLM (DeepSeek) ---
    deepseek_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not deepseek_key:
        return {"error": "No DeepSeek API key found. Set DEEPSEEK_API_KEY or OPENAI_API_KEY."}

    llm = LangchainLLMWrapper(ChatOpenAI(
        model="deepseek-chat",
        temperature=0,
        openai_api_key=deepseek_key,
        openai_api_base="https://api.deepseek.com",
    ))

    # --- Embedding (SiliconFlow bge-m3) ---
    siliconflow_key = os.environ.get("SILICONFLOW_API_KEY")
    if not siliconflow_key:
        return {"error": "No SiliconFlow API key found. Set SILICONFLOW_API_KEY."}

    embeddings = LangchainEmbeddingsWrapper(OpenAIEmbeddings(
        model="BAAI/bge-m3",
        openai_api_key=siliconflow_key,
        openai_api_base="https://api.siliconflow.cn/v1",
    ))

    # --- 控制 RAGAS 内部行为 ---
    # RAGAS 内部创建 embedding client 时也走 SiliconFlow
    os.environ["OPENAI_API_KEY"] = siliconflow_key
    os.environ["OPENAI_BASE_URL"] = "https://api.siliconflow.cn/v1"

    # --- 组装 Dataset ---
    ds_dict = {
        "question": input_data["questions"],
        "answer": input_data["answers"],
        "contexts": input_data["contexts"],
    }
    references = input_data.get("references", [])
    if references and len(references) == len(input_data["questions"]):
        ds_dict["reference"] = references

    dataset = Dataset.from_dict(ds_dict)

    # --- 选择指标 ---
    metrics = [faithfulness]

    # answer_relevancy 需要 embedding
    answer_relevancy.embeddings = embeddings
    metrics.append(answer_relevancy)

    # context_recall 需要 reference 列
    if "reference" in ds_dict:
        metrics.append(context_recall)

    result = evaluate(
        dataset=dataset,
        metrics=metrics,
        llm=llm,
        embeddings=embeddings,
    )

    # --- 调试：打印 result 类型 ---
    print(f"DEBUG result type: {type(result).__name__}", file=sys.stderr)
    if hasattr(result, 'column_names'):
        print(f"DEBUG column_names: {result.column_names}", file=sys.stderr)
    if hasattr(result, '_scores_dict'):
        print(f"DEBUG _scores_dict keys: {list(result._scores_dict.keys())}", file=sys.stderr)

    # --- 整理输出 ---
    scores: dict[str, list[float]] = {}
    metric_names = ["faithfulness", "answer_relevancy", "context_recall"]
    for metric_name in metric_names:
        try:
            vals = result[metric_name]
            if isinstance(vals, list):
                scores[metric_name] = [float(v) for v in vals]
            elif isinstance(vals, (int, float)):
                scores[metric_name] = [float(vals)]
            elif vals is not None:
                # 可能是 numpy array 或其它可迭代类型
                scores[metric_name] = [float(v) for v in vals]
        except (KeyError, TypeError) as e:
            print(f"DEBUG: failed to get {metric_name}: {e}", file=sys.stderr)
            pass

    # 尝试 to_pandas()
    if not scores.get("faithfulness"):
        try:
            df = result.to_pandas()
            print(f"DEBUG pandas columns: {list(df.columns)}", file=sys.stderr)
            for name in metric_names:
                if name in df.columns:
                    vals = df[name].tolist()
                    scores[name] = [float(v) for v in vals]
        except Exception as e:
            print(f"DEBUG pandas fallback failed: {e}", file=sys.stderr)

    aggregate = {}
    for name, vals in scores.items():
        arr = np.array(vals)
        aggregate[name] = {
            "mean": float(np.mean(arr)) if len(arr) > 0 else 0.0,
            "min": float(np.min(arr)) if len(arr) > 0 else 0.0,
            "max": float(np.max(arr)) if len(arr) > 0 else 0.0,
            "median": float(np.median(arr)) if len(arr) > 0 else 0.0,
        }

    return {"scores": scores, "aggregate": aggregate}


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "No input received"}))
        sys.exit(1)

    try:
        input_data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    result = run_ragas(input_data)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
