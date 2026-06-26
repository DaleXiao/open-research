# E2E — QA selection-input (M5.6)

真浏览器回归测试，验证 issue #22 修复：选中文字 → 不点 "?" 钮 → 直接点输入框 → 提问，请求带 `scope=selection + block_id`。

## 跑法
```bash
npm run build
python3 -m http.server 4399 --directory dist &
node e2e/qa-selection.e2e.mjs        # 默认 http://localhost:4399（mock /api）
# 或对 live：E2E_BASE=https://research.example.com node e2e/qa-selection.e2e.mjs（用真 worker，需改 mock 关闭）
```

## 断言（全 true 为过）
- RESULT-MAIN: hintShowsSelection / scopeSwitchedToSelection / askScopeSelection / askBlockId
  （核心 bug：选中→点输入框→ask 自动 scope=selection + 正确 block_id）
- RESULT-REGRESSION: oldPathScopeSelection / oldPathBlockId（"?" 钮显式路径不破）
- RESULT-FULL: fullScope / noBlockId（无选区问全文默认行为不变）

注：`selBtnFloatedButNotClicked` 为信息项（headless 下浮钮可见性 timing flaky；REGRESSION 路径已通过点击 ".qa-sel-btn" 证明浮钮工作）。
