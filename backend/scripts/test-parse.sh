#!/usr/bin/env bash
# research-worker 离线测试套件。
# 解析已挪客户端浏览器（research repo），worker 零解析 → 移除 fixture 解析回归 /
# pdf-parse / pdf-fallback / parse.test / import-async（ Queue）。worker 侧新增
# saveClientPaper 校验+落库回归。block ID 前后端逐字一致回归在 research repo（parse-arxiv-parity）。
set -euo pipefail
cd "$(dirname "$0")/.."

# client-parse import 契约（saveClientPaper 校验 + 落库 + 缓存语义，离线）
echo "===== import-client ====="
if ! npx tsx test/import-client.test.ts; then echo " IMPORT-CLIENT TESTS FAILED"; exit 1; fi

# M2 翻译/缓存/对照视图单测（mock gateway，离线）
echo "===== M2 translate ====="
if ! npx tsx test/translate.test.ts; then echo "M2 TESTS FAILED"; exit 1; fi

# M5 QA 单测（mock gateway，离线）
echo "===== M5 qa ====="
if ! npx tsx test/qa.test.ts; then echo "M5 QA TESTS FAILED"; exit 1; fi

# 入口鉴权单测（防 API 白嫖，离线）
echo "===== auth ====="
if ! npx tsx test/auth.test.ts; then echo "AUTH TESTS FAILED"; exit 1; fi

# F2 导入记录列表单测（GET /api/papers，离线）
echo "===== F2 papers ====="
if ! npx tsx test/papers.test.ts; then echo "F2 PAPERS TESTS FAILED"; exit 1; fi

# F5 论文删除级联单测（DELETE /api/paper/:id，离线）
echo "===== F5 delete ====="
if ! npx tsx test/delete-paper.test.ts; then echo "F5 DELETE TESTS FAILED"; exit 1; fi

# F1 批注（划词笔记 + 锚定 + 书签）单测（内存 D1 mock，离线）
echo "===== F1 annotations ====="
if ! npx tsx test/annotations.test.ts; then echo "F1 ANNOTATIONS TESTS FAILED"; exit 1; fi

# F4 思维导图（markmap 脑图生成 + 缓存 + 切语言，离线 mock gateway）
echo "===== F4 mindmap ====="
if ! npx tsx test/mindmap.test.ts; then echo "F4 MINDMAP TESTS FAILED"; exit 1; fi

# URL 解析单测（arxiv-url 归一化）
echo "===== url ====="
if ! npx tsx test/url.test.ts; then echo "URL TESTS FAILED"; exit 1; fi

echo "ALL WORKER TESTS PASS ✅"
