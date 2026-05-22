"""
DeepEval 断言脚本 — CI 门禁

用法：
  python scripts/eval/DeepEval/assert_test.py                    # 默认阈值 0.05 (5%)
  python scripts/eval/DeepEval/assert_test.py 0.03               # 阈值 3%

读取 DeepEval 最新的 result.json，检查 hallucination 均值是否超过阈值。
退出码 0 = PASS, 1 = FAIL。
"""
import json
import sys
from pathlib import Path

RESULT_PATH = Path(__file__).resolve().parent / "result.json"

if not RESULT_PATH.exists():
    print(f"FAIL: 未找到 {RESULT_PATH}，请先运行 pnpm eval:deepeval")
    sys.exit(1)

with open(RESULT_PATH, encoding="utf-8") as f:
    data = json.load(f)

hallu = data["deepeval"]["aggregate"]["hallucination"]["mean"]
threshold = float(sys.argv[1]) if len(sys.argv) > 1 else 0.05

if hallu > threshold:
    print(f"FAIL: hallucination {hallu:.1%} > threshold {threshold:.1%}")
    sys.exit(1)

print(f"PASS: hallucination {hallu:.1%} <= threshold {threshold:.1%}")
