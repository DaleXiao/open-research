#!/usr/bin/env bash
# M2 / — 真翻一篇真实论文 e2e（DoD 最后一环）。
#
# ⛔ 需 prod gateway 配好 SERVICE_TOKEN_RESEARCH（set with wrangler secret put）。
#    没 token 时本脚本「跳过」而非「失败」，便于 CI/本地在 token 落地前不报红。
#
# 验收（token 落地后）：抓真实 arXiv → parse → 懒翻视口 para → 中英对照 → 公式不坏。
# 跑法：
# RESEARCH_TOKEN=<token> GATEWAY_URL=https://api-llm.example.com \
#     bash scripts/e2e-translate.sh [arxiv_id]
#
# 默认论文：1706.03762v7（Attention Is All You Need）。
set -euo pipefail
cd "$(dirname "$0")/.."

ARXIV_ID="${1:-1706.03762v7}"
GATEWAY_URL="${GATEWAY_URL:-https://api-llm.example.com}"
TOKEN="${RESEARCH_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "⏭  SKIP: RESEARCH_TOKEN 未设置 —— M2 DoD 真翻步骤需 gateway token。"
  echo "   token 落地后：RESEARCH_TOKEN=<t> bash scripts/e2e-translate.sh $ARXIV_ID"
  exit 0
fi

# 先验 gateway 对 research token 放行（chat 200），不放行就早失败，别浪费抓取。
echo "▸ 验 gateway /v1/chat/completions（research token）..."
code="$(curl -s -o /tmp/e2e-chat.json -w '%{http_code}' -X POST "$GATEWAY_URL/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"model":"qwen-mt-turbo","messages":[{"role":"user","content":"The model learns."}],"translation_options":{"source_lang":"English","target_lang":"Chinese"}}')"
if [ "$code" != "200" ]; then
  echo "✗ gateway 返回 $code（期望 200）。SERVICE_TOKEN_RESEARCH 可能未配到 prod。"
  head -c 300 /tmp/e2e-chat.json; echo
  exit 1
fi
echo "  ✓ gateway 200，research token live。译文样例：$(python3 -c "import json,sys;print(json.load(open('/tmp/e2e-chat.json'))['choices'][0]['message']['content'][:40])" 2>/dev/null || echo '?')"

# 端到端：parse → 懒翻前若干 para → 断言公式不坏 + 有中文。
echo "▸ e2e parse + 懒翻 $ARXIV_ID ..."
RESEARCH_TOKEN="$TOKEN" GATEWAY_URL="$GATEWAY_URL" npx tsx scripts/e2e-translate.ts "$ARXIV_ID"
echo "✅ M2 e2e PASS — 一篇真实论文可读，公式不坏。"
