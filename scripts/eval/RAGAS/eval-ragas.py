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
    total = len(dataset)

    # --- 选择指标 ---
    metrics = [faithfulness]
    answer_relevancy.embeddings = embeddings
    metrics.append(answer_relevancy)
    if "reference" in ds_dict:
        metrics.append(context_recall)

    # --- 分批处理 + 进度输出 ---
    BATCH = 25
    metric_names = ["faithfulness", "answer_relevancy", "context_recall"]
    all_scores: dict[str, list[float]] = {m: [] for m in metric_names}

    for start in range(0, total, BATCH):
        end = min(start + BATCH, total)
        batch = dataset.select(range(start, end))
        result = evaluate(batch, metrics=metrics, llm=llm, embeddings=embeddings)
        for metric_name in metric_names:
            try:
                vals = result[metric_name]
                if isinstance(vals, (list, tuple)):
                    all_scores[metric_name].extend([float(v) for v in vals])
                elif isinstance(vals, (int, float)):
                    all_scores[metric_name].append(float(vals))
                elif vals is not None:
                    all_scores[metric_name].extend([float(v) for v in vals])
            except (KeyError, TypeError):
                pass
        print(f"PROGRESS: {end}/{total}", file=sys.stderr, flush=True)

    # --- 尝试 to_pandas() 兜底 ---
    if not all_scores.get("faithfulness"):
        try:
            df = evaluate(dataset, metrics=metrics, llm=llm, embeddings=embeddings).to_pandas()
            for name in metric_names:
                if name in df.columns:
                    vals = df[name].tolist()
                    all_scores[name] = [float(v) for v in vals]
        except Exception:
            pass

    aggregate = {}
    for name, vals in all_scores.items():
        if not vals:
            continue
        arr = np.array(vals)
        aggregate[name] = {
            "mean": float(np.mean(arr)) if len(arr) > 0 else 0.0,
            "min": float(np.min(arr)) if len(arr) > 0 else 0.0,
            "max": float(np.max(arr)) if len(arr) > 0 else 0.0,
            "median": float(np.median(arr)) if len(arr) > 0 else 0.0,
        }

    return {"scores": all_scores, "aggregate": aggregate}


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
