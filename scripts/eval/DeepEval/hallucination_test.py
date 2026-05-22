"""
DeepEval hallucination 评估脚本 — 数据评估 Step 3

stdin 读入 JSON → DeepEval HallucinationMetric → stdout 输出 JSON

输入格式：
{
  "questions": ["q1", ...],
  "answers": ["a1", ...],
  "contexts": [["ctx1a", ...], ...]
}

输出格式：
{
  "scores": { "hallucination": [0.1, ...] },
  "aggregate": { "hallucination": { "mean": 0.5, "min": 0, "max": 1, "median": 0.5 } },
  "reasons": ["reason 1", ...]
}
"""

import json
import os
import sys
from pathlib import Path

# 加载 .env
_env_path = Path(__file__).resolve().parents[3] / '.env'
if _env_path.exists():
    with open(_env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

# 确保 stdin UTF-8（Windows GBK 兼容）
if sys.stdin.encoding != 'utf-8':
    sys.stdin.reconfigure(encoding='utf-8')


def run_deepeval(input_data: dict) -> dict:
    from deepeval.metrics import HallucinationMetric
    from deepeval.test_case import LLMTestCase
    from deepeval.models import GPTModel

    deepseek_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not deepseek_key:
        return {"error": "No DeepSeek API key found. Set DEEPSEEK_API_KEY."}

    # DeepEval 内部使用 OpenAI 客户端，指向 DeepSeek
    os.environ["OPENAI_API_KEY"] = deepseek_key
    os.environ["OPENAI_BASE_URL"] = "https://api.deepseek.com"

    questions = input_data["questions"]
    answers = input_data["answers"]
    contexts = input_data["contexts"]
    total = len(questions)

    # 显式指定模型名，否则 DeepEval 4.x 默认用 gpt-5.4 (DeepSeek 不支持)
    model = GPTModel(model="deepseek-v4-flash")
    metric = HallucinationMetric(threshold=0.5, model=model)

    scores: list[float] = []
    reasons: list[str] = []

    for i in range(total):
        test_case = LLMTestCase(
            input=questions[i],
            actual_output=answers[i],
            context=contexts[i],
        )
        try:
            metric.measure(test_case)
            scores.append(metric.score)
            reasons.append(metric.reason or "")
        except Exception as e:
            scores.append(0.0)
            reasons.append(f"Error: {e}")
        print(f"PROGRESS: {i + 1}/{total}", file=sys.stderr, flush=True)

    import numpy as np

    arr = np.array(scores)
    aggregate = {
        "hallucination": {
            "mean": float(np.mean(arr)) if len(arr) > 0 else 0.0,
            "min": float(np.min(arr)) if len(arr) > 0 else 0.0,
            "max": float(np.max(arr)) if len(arr) > 0 else 0.0,
            "median": float(np.median(arr)) if len(arr) > 0 else 0.0,
        }
    }

    return {"scores": {"hallucination": scores}, "aggregate": aggregate, "reasons": reasons}


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

    result = run_deepeval(input_data)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
