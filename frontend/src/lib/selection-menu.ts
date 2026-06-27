// 划词选区菜单（F1 fix）。
// 根因：notes-ui 的「+note」浮钮与 qa-ui 的「?」浮钮各自监听同一 selection、抢同一 rect 位置 → 互盖。
// 方案：单一共享浮动菜单。选区 settle 一次性算 blockId/rect/段内 offset，渲染**一个**菜单，
//       各功能（问 AI / 记笔记）register 一个 action 项并排，不再各画各的钮、不互盖。
// 视觉延续 terminal：mono / 现有 token / 单色 currentColor SVG。

import { t } from "./i18n";

export interface SelectionPick {
  blockId: string;
  text: string;
  /** 段内字符 offset（best-effort）；跨 block 选区降级 null。 */
  selStart: number | null;
  selEnd: number | null;
}

export interface SelectionAction {
  /** 稳定 id（用于 data-action，便于测试/调试）。 */
  id: string;
  /** 文案 i18n key。 */
  labelKey: string;
  /** aria-label i18n key。 */
  ariaKey: string;
  /** 单色 SVG 图标工厂。 */
  icon: () => SVGElement;
  /** 选中并点击该项时回调（菜单已隐藏，选区 snapshot 传入）。 */
  onPick: (sel: SelectionPick) => void;
}

export interface SelectionMenu {
  register: (a: SelectionAction) => void;
  /** 最近一次有效选区 snapshot（供「输入框获焦自动采用」等无按钮路径复用）。 */
  getLastSelection: () => SelectionPick | null;
  /** 消费/清空选区 snapshot（如一次问答/记笔记后）。 */
  clearLastSelection: () => void;
  /** i18n 切换后刷新按钮文案（reader 监听 UILANG_EVENT 后调用）。 */
  refreshI18n: () => void;
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

// 段内字符 offset（best-effort）：选区锚点与焦点都在同一 block 内才算 start/end，跨 block 返 null。
function selOffsets(sel: Selection, blockEl: HTMLElement): { start: number | null; end: number | null } {
  try {
    const range = sel.getRangeAt(0);
    if (!blockEl.contains(range.startContainer) || !blockEl.contains(range.endContainer)) {
      return { start: null, end: null };
    }
    const pre = range.cloneRange();
    pre.selectNodeContents(blockEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const end = start + range.toString().length;
    return { start, end };
  } catch {
    return { start: null, end: null };
  }
}

function blockIdFromNode(node: Node | null): string | null {
  let cur: Node | null = node;
  while (cur && cur !== document.body) {
    if (cur instanceof HTMLElement && cur.dataset.block) return cur.dataset.block;
    cur = cur.parentNode;
  }
  return null;
}

export function mountSelectionMenu(root: HTMLElement): SelectionMenu {
  const stream = root.querySelector<HTMLElement>("#stream");

  const menu = el("div", { class: "sel-menu", "data-open": "0", role: "toolbar" });
  document.body.append(menu);

  const actions: SelectionAction[] = [];
  const buttons = new Map<string, HTMLButtonElement>();
  let lastSelection: SelectionPick | null = null;

  function hide() {
    menu.dataset.open = "0";
  }

  function rebuildButtons() {
    menu.replaceChildren();
    buttons.clear();
    for (const a of actions) {
      const btn = el("button", {
        class: "sel-menu-btn",
        type: "button",
        "data-action": a.id,
        "aria-label": t(a.ariaKey),
      });
      btn.append(a.icon(), el("span", { class: "sel-menu-label" }, t(a.labelKey)));
      // 别清掉选区（mousedown 默认会失焦/清选区）
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        const pick = lastSelection;
        hide();
        if (pick) a.onPick(pick);
      });
      buttons.set(a.id, btn);
      menu.append(btn);
    }
  }

  function onSelectionSettled() {
    if (!actions.length) return hide();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
    const text = sel.toString().trim();
    if (!text) return hide();
    const blockId = blockIdFromNode(sel.anchorNode) || blockIdFromNode(sel.focusNode);
    if (!blockId || !stream?.contains(sel.anchorNode)) return hide();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return hide();
    const blockEl = stream.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
    const off = blockEl ? selOffsets(sel, blockEl) : { start: null, end: null };
    lastSelection = { blockId, text, selStart: off.start, selEnd: off.end };
    // 菜单浮在选区右上方；right 对齐 + 上移，避免盖住选中文字。
    menu.style.top = `${window.scrollY + rect.top - 38}px`;
    menu.style.left = `${window.scrollX + rect.right}px`;
    menu.dataset.open = "1";
  }

  document.addEventListener("mouseup", () => setTimeout(onSelectionSettled, 0));
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hide();
  });
  window.addEventListener("scroll", hide, { passive: true });

  return {
    register(a: SelectionAction) {
      actions.push(a);
      rebuildButtons();
    },
    getLastSelection: () => lastSelection,
    clearLastSelection: () => {
      lastSelection = null;
    },
    refreshI18n() {
      for (const a of actions) {
        const btn = buttons.get(a.id);
        if (!btn) continue;
        btn.setAttribute("aria-label", t(a.ariaKey));
        const label = btn.querySelector(".sel-menu-label");
        if (label) label.textContent = t(a.labelKey);
      }
    },
  };
}
