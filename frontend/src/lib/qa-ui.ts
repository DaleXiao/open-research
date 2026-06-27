// 「AI 问 paper」UI 层（M5）。reader.ts 仅调用 mountQa 一个入口，
// 业务逻辑（import/translate/对照/公式/昼夜/中英）零侵入。
// 视觉严格延续 M4 terminal：mono 字体 / 现有终端 token / 单色 currentColor SVG。

import { ApiError, askPaper, listQa, type QaLang, type QaRecord, type QaScope } from "./qa";
import { applyI18n, getUiLang, t, UILANG_EVENT } from "./i18n";
import type { SelectionMenu, SelectionPick } from "./selection-menu";

/**
 * M5.2：按 ApiError code 分级提问错误文案（走 M6 i18n key）。
 * gateway_timeout → qa.error.timeout；gateway_error/502/503/504 → qa.error.gateway；其余 → qa.error.generic。
 */
function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "gateway_timeout") return t("qa.error.timeout");
    if (e.code === "gateway_error" || e.status === 502 || e.status === 503 || e.status === 504) {
      return t("qa.error.gateway");
    }
    return t("qa.error.generic");
  }
  return t("qa.error.generic");
}

export interface QaDeps {
  /** 当前论文视图（含 paper_id 与 blocks，用于 cited 跳锚点）。无 paper 时返回 null。 */
  getPaper: () => { paper_id: string; blocks: { id: string; anchor: string }[] } | null;
  /** 当前阅读语言（both/zh→zh，en→en）。 */
  getLang: () => QaLang;
  /** 复用 reader 的锚点跳转。 */
  jumpTo: (anchor: string) => void;
  /** F1 fix：共享划词选区菜单（替代各自的浮钮，不互盖）。 */
  selMenu: SelectionMenu;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
};

// 单色 SVG：→ (send) / ? (selection-ask) / ✕ (close) — 全 stroke=currentColor。
function iconSend(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M4 12h14m0 0l-5-5m5 5l-5 5");
  svg.append(p);
  return svg;
}

export function mountQa(root: HTMLElement, deps: QaDeps): void {
  const drawer = root.querySelector<HTMLElement>("#qa-drawer");
  const openBtn = root.querySelector<HTMLButtonElement>("#qa-open");
  const closeBtn = root.querySelector<HTMLButtonElement>("#qa-close");
  const historyPane = root.querySelector<HTMLElement>("#qa-history");
  const form = root.querySelector<HTMLFormElement>("#qa-form");
  const input = root.querySelector<HTMLInputElement>("#qa-q");
  const sendBtn = root.querySelector<HTMLButtonElement>("#qa-send");
  const scopeSeg = root.querySelector<HTMLElement>("#qa-scope");
  const selHint = root.querySelector<HTMLElement>("#qa-sel-hint");
  if (!drawer || !openBtn || !closeBtn || !historyPane || !form || !input || !sendBtn || !scopeSeg)
    return;

  let scope: QaScope = "full";
  let pendingBlockId: string | null = null; // selection scope 下选中的 block
  let loadedFor: string | null = null; // 已加载历史的 paper_id
  // M5.6：选区 snapshot 现由共享 selMenu 管理（F1 fix）；这里不再自存。

  function setScope(next: QaScope) {
    scope = next;
    for (const b of scopeSeg!.querySelectorAll<HTMLButtonElement>("button[data-scope]")) {
      b.setAttribute("aria-pressed", b.dataset.scope === next ? "true" : "false");
    }
    if (selHint) {
      if (next === "selection" && pendingBlockId) {
        selHint.textContent = `${t("qa.sel.prefix")}${pendingBlockId}`;
        selHint.hidden = false;
      } else if (next === "selection") {
        selHint.textContent = t("qa.sel.need");
        selHint.hidden = false;
      } else {
        selHint.hidden = true;
      }
    }
  }

  // cited block_id → anchor，跳转复用 reader jumpTo
  function jumpToBlock(blockId: string) {
    const paper = deps.getPaper();
    const blk = paper?.blocks.find((x) => x.id === blockId);
    if (blk) deps.jumpTo(blk.anchor);
    else {
      // 兜底：直接按 data-block 滚动
      document
        .querySelector(`[data-block="${CSS.escape(blockId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderCited(ids: string[]): HTMLElement {
    const wrap = el("div", { class: "qa-cited" });
    wrap.append(el("span", { class: "qa-cited-label" }, t("qa.cited.label")));
    if (!ids.length) {
      wrap.append(el("span", { class: "qa-cited-none" }, " —"));
      return wrap;
    }
    for (const id of ids) {
      const chip = el("button", { class: "qa-chip", type: "button", title: `${t("qa.jumpPrefix")}${id}` }, id);
      chip.addEventListener("click", () => jumpToBlock(id));
      wrap.append(chip);
    }
    return wrap;
  }

  function renderRecord(r: Pick<QaRecord, "question" | "answer" | "cited_block_ids" | "scope">): HTMLElement {
    const item = el("div", { class: "qa-item" });
    const q = el("div", { class: "qa-q" });
    q.append(el("span", { class: "qa-q-prefix", "aria-hidden": "true" }, "❯ "), r.question);
    const a = el("div", { class: "qa-a" }, r.answer);
    item.append(q, a, renderCited(r.cited_block_ids || []));
    if (r.scope === "selection") item.dataset.scope = "selection";
    return item;
  }

  function appendRecord(r: Parameters<typeof renderRecord>[0]): HTMLElement {
    const empty = historyPane!.querySelector(".qa-empty");
    if (empty) empty.remove();
    const node = renderRecord(r);
    historyPane!.append(node);
    historyPane!.scrollTop = historyPane!.scrollHeight;
    return node;
  }

  async function loadHistory() {
    const paper = deps.getPaper();
    if (!paper) {
      historyPane!.replaceChildren(el("p", { class: "qa-empty" }, t("qa.empty.import")));
      loadedFor = null;
      return;
    }
    if (loadedFor === paper.paper_id) return;
    historyPane!.replaceChildren(el("p", { class: "qa-empty" }, t("qa.empty.loading")));
    try {
      const res = await listQa(paper.paper_id);
      historyPane!.replaceChildren();
      if (!res.history.length) {
        historyPane!.append(el("p", { class: "qa-empty" }, t("qa.empty.none")));
      } else {
        for (const r of res.history) historyPane!.append(renderRecord(r));
        historyPane!.scrollTop = historyPane!.scrollHeight;
      }
      loadedFor = paper.paper_id;
    } catch (e) {
      historyPane!.replaceChildren(
        el("p", { class: "qa-empty qa-err" }, e instanceof ApiError ? `// ${e.message}` : `// ${String(e)}`),
      );
    }
  }

  function openDrawer(focus = true) {
    drawer!.dataset.open = "1";
    drawer!.setAttribute("aria-hidden", "false");
    openBtn!.setAttribute("aria-expanded", "true");
    loadHistory();
    if (focus) setTimeout(() => input!.focus(), 60);
  }

  function closeDrawer() {
    drawer!.dataset.open = "0";
    drawer!.setAttribute("aria-hidden", "true");
    openBtn!.setAttribute("aria-expanded", "false");
  }

  async function submit() {
    const paper = deps.getPaper();
    const question = input!.value.trim();
    if (!question) return;
    if (!paper) {
      appendRecord({ question, answer: t("qa.needPaper"), cited_block_ids: [], scope });
      return;
    }
    if (scope === "selection" && !pendingBlockId) {
      setScope("selection");
      if (selHint) selHint.textContent = t("qa.sel.needSend");
      return;
    }
    input!.disabled = true;
    sendBtn!.disabled = true;
    const pending = appendRecord({ question, answer: "…thinking", cited_block_ids: [], scope });
    pending.dataset.pending = "1";
    const ansEl = pending.querySelector<HTMLElement>(".qa-a");
    try {
      const res = await askPaper(paper.paper_id, {
        scope,
        block_id: scope === "selection" ? pendingBlockId || undefined : undefined,
        question,
        lang: deps.getLang(),
      });
      pending.dataset.pending = "0";
      if (ansEl) ansEl.textContent = res.answer;
      const oldCited = pending.querySelector(".qa-cited");
      if (oldCited) oldCited.replaceWith(renderCited(res.cited_block_ids || []));
      input!.value = "";
      loadedFor = paper.paper_id; // 历史已含本条，避免重载丢失
      // M5.6：一次问答消费掉 snapshot，避免下次误用旧选区。
      deps.selMenu.clearLastSelection();
    } catch (e) {
      pending.dataset.pending = "0";
      if (ansEl) {
        ansEl.classList.add("qa-err");
        // M5.2：按 ApiError code 分级文案，不再裸“后端返回非 JSON”。
        ansEl.textContent = errorText(e);
      }
    } finally {
      input!.disabled = false;
      sendBtn!.disabled = false;
      input!.focus();
    }
  }

  // send 按钮图标（避免在 .astro 里手写 SVG 重复，统一单色 currentColor）
  sendBtn.prepend(iconSend());

  openBtn.addEventListener("click", () => {
    if (drawer.dataset.open === "1") closeDrawer();
    else openDrawer();
  });
  closeBtn.addEventListener("click", closeDrawer);
  scopeSeg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-scope]");
    if (b) {
      const next = b.dataset.scope as QaScope;
      // M5.6：用户主动切到 full → 放弃已捕获的选区 snapshot（不再自动对选中段提问）。
      if (next === "full") {
        pendingBlockId = null;
        deps.selMenu.clearLastSelection();
      }
      setScope(next);
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  // M5.6 / F1 fix：input 获焦/按下时，若共享 selMenu 有已捕获选区 snapshot，
  // 自动切 scope=selection + 设 pendingBlockId，让选中文字→点输入框→打字→发送全程不用点菜单。
  function adoptSelectionIfAny() {
    const last = deps.selMenu.getLastSelection();
    if (last && last.blockId) {
      pendingBlockId = last.blockId;
      setScope("selection"); // selHint 会显示选中 block，用户可见反馈
    }
  }
  input.addEventListener("focus", adoptSelectionIfAny);
  input.addEventListener("mousedown", adoptSelectionIfAny);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.dataset.open === "1") closeDrawer();
  });

  // ── F1 fix：注册到共享划词选区菜单的「问 AI」项（不再自画 "?" 浮钮） ──
  // 选中文字 → 菜单出「问 AI」+「记笔记」两项并排，点「问 AI」→ 设选区 scope + 开抽屉。
  function qaSelIcon(): SVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M9.1 9a3 3 0 1 1 4.4 2.6c-.9.5-1.5 1.1-1.5 2.4");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "17.5");
    dot.setAttribute("r", "0.6");
    svg.append(p, dot);
    return svg;
  }
  deps.selMenu.register({
    id: "ask",
    labelKey: "qa.selbtn.label",
    ariaKey: "qa.selbtn.aria",
    icon: qaSelIcon,
    onPick: (pick: SelectionPick) => {
      pendingBlockId = pick.blockId;
      setScope("selection");
      openDrawer(true);
    },
  });

  // ── M6 i18n：初始 apply + 监听 UI 语言切换，重染动态文案 ──
  applyI18n(root, getUiLang());
  window.addEventListener(UILANG_EVENT, () => {
    applyI18n(root, getUiLang());
    // 静态抽屉内部 selHint 是 JS 动态写，按当前 scope 重刷
    setScope(scope);
    // 历史区空态提示（未加载 paper）也重刷
    const emptyImport = historyPane!.querySelector(".qa-empty");
    if (emptyImport && !deps.getPaper()) emptyImport.textContent = t("qa.empty.import");
  });

  // F3-fix3：切论文统一失效。重置 loadedFor，抽屉开着则重载新论文问答历史。
  //   （loadedFor 守卫已防误用，这里是抽屉开着切 paper 时主动刷新。）
  window.addEventListener("research:paper-change", () => {
    loadedFor = null;
    if (drawer!.dataset.open === "1") loadHistory();
  });
}
