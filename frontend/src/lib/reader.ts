// 对照阅读视图客户端逻辑（M3 REWORK）。
// 新增：① 翻译触发（整篇 + 单段按需）② 中英显示切换（对照/仅中/仅英）
//       ③ 昼夜手动切换（持久化）④ responsive 由 CSS 接管，JS 只管交互。

import katex from "katex";
import {
  ApiError,
  deletePaper,
  getView,
  importParsed,
  listPapers,
  translate,
  translateAll,
  type BilingualBlock,
  type BilingualView,
  type PaperListItem,
  type SectionNode,
} from "./api";
import { parseSourceClient, paperIdForClient, ParseClientError } from "./parse-client";
import { mountQa } from "./qa-ui";
import { mountNotes } from "./notes-ui";
import { mountMindmap } from "./mindmap";
import { mountSelectionMenu } from "./selection-menu";
import { applyI18n, getUiLang, mountUiLangSwitch, t, UILANG_EVENT } from "./i18n";

type ViewMode = "both" | "zh" | "en";
type Theme = "day" | "night";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function renderInlineMath(target: HTMLElement, text: string): void {
  const re = /\$([^$]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) target.append(text.slice(last, m.index));
    const span = el("span");
    try {
      katex.render(m[1], span, { throwOnError: false, displayMode: false });
    } catch {
      span.textContent = m[0];
    }
    target.append(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) target.append(text.slice(last));
}

function renderDisplayMath(latex: string): HTMLElement {
  const box = el("div", { class: "blk-math" });
  try {
    katex.render(latex, box, { throwOnError: false, displayMode: true });
  } catch {
    box.textContent = latex;
  }
  return box;
}

// F5：垃圾桶图标（单色 currentColor SVG，终端风）。
function trashSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute(
    "d",
    "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7m4 4v6m4-6v6",
  );
  svg.append(p);
  return svg;
}

// ── Theme（昼夜手动切换 + 持久化） ──
const THEME_KEY = "research.theme";

function getInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY) as Theme | null;
  if (saved === "day" || saved === "night") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "day" : "night";
}

function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);
}

// ── F2：记住上次打开的 paper（进站自动恢复） ──
const LAST_PAPER_KEY = "research:last_paper";

function saveLastPaper(paperId: string): void {
  try {
    localStorage.setItem(LAST_PAPER_KEY, paperId);
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

function getLastPaper(): string | null {
  try {
    return localStorage.getItem(LAST_PAPER_KEY);
  } catch {
    return null;
  }
}

// 倒序列表日期：YYYY-MM-DD（本地时），终端风紧凑。
function fmtDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 主控制器 ──
export function mountReader(root: HTMLElement): void {
  const importInput = $("#paper-input", root) as HTMLInputElement;
  const importBtn = $("#import-btn", root) as HTMLButtonElement;
  const statusBar = $("#status", root) as HTMLElement;
  const tocPane = $("#toc", root) as HTMLElement;
  const stream = $("#stream", root) as HTMLElement;
  const titleEl = $("#paper-title", root) as HTMLElement;
  const transBtn = $("#translate-btn", root) as HTMLButtonElement;
  const progress = $("#progress", root) as HTMLElement;
  const themeBtn = $("#theme-btn", root) as HTMLButtonElement;
  const themeLabel = $("#theme-label", root) as HTMLElement | null;
  const viewSeg = $("#view-seg", root) as HTMLElement;
  const papersBtn = $("#papers-open", root) as HTMLButtonElement | null;

  let current: BilingualView | null = null;
  let viewMode: ViewMode = "both";
  let theme: Theme = getInitialTheme();
  const blockEls = new Map<string, HTMLElement>();

  applyTheme(theme);
  syncThemeBtn();

  function syncThemeBtn() {
    // terminal：主题钮纯单色 SVG（无文字 label），图标由 CSS 按 data-theme
    // 指示「点击后的目标」（夜显太阳→切白 / 昼显月亮→切夜）。
    // aria 也指目标态：夜间→切到日间，白天→切到夜间。themeLabel 已移除（null 守卫）。
    if (themeLabel) themeLabel.textContent = "";
    themeBtn.setAttribute("aria-label", theme === "night" ? t("theme.toDay") : t("theme.toNight"));
  }

  const setStatus = (msg: string, kind: "info" | "error" | "ok" = "info") => {
    statusBar.textContent = msg;
    statusBar.dataset.kind = kind;
  };

  const jumpTo = (anchor: string) => {
    stream.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  function setViewMode(mode: ViewMode) {
    viewMode = mode;
    stream.dataset.view = mode;
    for (const btn of viewSeg.querySelectorAll("button")) {
      btn.setAttribute("aria-pressed", btn.dataset.mode === mode ? "true" : "false");
    }
    // F4：阅读语言（zh/en）变化通知脑图（开着则销毁重建）。
    window.dispatchEvent(new CustomEvent("research:viewlang"));
  }

  // 单段译文填充（懒翻或整篇回填共用）
  function fillZh(b: BilingualBlock, text_zh: string) {
    const row = blockEls.get(b.id);
    if (!row) return;
    const zhCol = row.querySelector<HTMLElement>(".col-zh");
    if (!zhCol) return;
    zhCol.replaceChildren();
    zhCol.className = "col col-zh zh-done";
    renderInlineMath(zhCol, text_zh);
    row.querySelector(".blk-translate-one")?.remove();
  }

  // 单段按需翻译
  async function translateOne(b: BilingualBlock, btn: HTMLButtonElement) {
    if (!current) return;
    btn.disabled = true;
    btn.textContent = t("translate.one.loading");
    try {
      const r = await translate(current.paper_id, { blockIds: [b.id] });
      const tr = r.translated.find((x) => x.block_id === b.id);
      if (tr) {
        b.text_zh = tr.text_zh;
        b.zh_status = "done";
        fillZh(b, tr.text_zh);
        current.stats.translated++;
        updateProgress();
      } else {
        btn.disabled = false;
        btn.textContent = t("translate.one.retry");
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = t("translate.one.retry");
      setStatus(e instanceof ApiError ? `${t("status.paraFailPrefix")}${e.message}` : String(e), "error");
    }
  }

  function renderBlock(b: BilingualBlock): HTMLElement {
    if (b.type === "heading") {
      const lvl = Math.min(Math.max(b.level, 1), 4);
      const h = el(`h${lvl}` as "h2", { class: "blk-heading", id: b.anchor, "data-block": b.id });
      const en = el("span", { class: "h-en" });
      renderInlineMath(en, b.text_en);
      h.append(en);
      if (b.text_zh) h.append(el("span", { class: "h-zh" }, b.text_zh));
      blockEls.set(b.id, h);
      return h;
    }
    if (b.type === "math") {
      const wrap = el("div", { class: "blk-row blk-row--math", "data-block": b.id, id: b.anchor });
      if (b.latex) wrap.append(renderDisplayMath(b.latex));
      blockEls.set(b.id, wrap);
      return wrap;
    }
    if (b.type === "figure") {
      const wrap = el("figure", { class: "blk-fig", "data-block": b.id, id: b.anchor });
      if (b.img_url) wrap.append(el("img", { src: b.img_url, loading: "lazy", alt: b.caption || "figure" }));
      if (b.caption) wrap.append(el("figcaption", {}, b.caption));
      blockEls.set(b.id, wrap);
      return wrap;
    }
    // para：左英右中
    const row = el("div", { class: "blk-row", "data-block": b.id, id: b.anchor });
    const enCol = el("div", { class: "col col-en" });
    renderInlineMath(enCol, b.text_en);
    const zhCol = el("div", { class: `col col-zh zh-${b.zh_status}` });
    if (b.zh_status === "done" && b.text_zh) {
      renderInlineMath(zhCol, b.text_zh);
    } else if (b.zh_status === "pending") {
      // 待翻：占位 + 单段「翻译此段」触发
      const ph = el("span", { class: "zh-placeholder" }, t("zh.placeholder"));
      const one = el("button", { class: "blk-translate-one", title: t("translate.one.title") }, t("translate.one.label"));
      one.addEventListener("click", () => translateOne(b, one));
      zhCol.append(ph, one);
    }
    row.append(enCol, zhCol);
    blockEls.set(b.id, row);
    return row;
  }

  function renderToc(toc: SectionNode[]): HTMLElement {
    const list = el("ul", { class: "toc-list" });
    const walk = (nodes: SectionNode[], depth: number) => {
      for (const n of nodes) {
        const li = el("li", { class: `toc-item toc-l${depth}` });
        const a = el("a", { href: `#${n.id}` }, n.title);
        a.addEventListener("click", (e) => {
          e.preventDefault();
          jumpTo(n.id);
        });
        li.append(a);
        list.append(li);
        if (n.children?.length) walk(n.children, depth + 1);
      }
    };
    walk(toc, 0);
    return list;
  }

  function paint(view: BilingualView) {
    current = view;
    blockEls.clear();
    titleEl.textContent = view.title;
    document.title = `${view.title} · research`;
    tocPane.replaceChildren(renderToc(view.toc));
    const frag = document.createDocumentFragment();
    for (const b of view.blocks) frag.append(renderBlock(b));
    stream.replaceChildren(frag);
    updateProgress();
    transBtn.disabled = view.stats.translated >= view.stats.translatable;
    saveLastPaper(view.paper_id);
    // F1：paint 后重载批注 + 重渲书签（重渲染重锚靠 block_id）。
    (root as any).__notesReload?.();
    // F3-fix3：切论文统一失效信号。各前端子模块（mindmap/notes/qa/翻译）
    //   订阅 research:paper-change 各自 reset per-paper state，防未来新模块再漏 paper_id 维度。
    window.dispatchEvent(
      new CustomEvent("research:paper-change", { detail: { paperId: view.paper_id } }),
    );
  }

  // ── F2：空工作区「最近导入」列表（终端风，点击 = getView 秒开） ──
  // F5：每项加删除钮（垃圾桶）+ 确认对话框。内存镜像便于删后局部移除。
  let recentPapers: PaperListItem[] = [];

  function renderRecentList(papers: PaperListItem[]): HTMLElement {
    recentPapers = papers;
    const wrap = el("div", { class: "recent" });
    wrap.append(
      el("div", { class: "recent-head" }, el("span", { "data-i18n": "recent.title" }, t("recent.title"))),
    );
    if (!papers.length) {
      wrap.append(el("p", { class: "recent-empty", "data-i18n": "recent.empty" }, t("recent.empty")));
      return wrap;
    }
    const list = el("ul", { class: "recent-list" });
    for (const p of papers) {
      list.append(renderRecentItem(p));
    }
    wrap.append(list);
    return wrap;
  }

  function renderRecentItem(p: PaperListItem): HTMLElement {
    const li = el("li", { class: "recent-item", "data-paper": p.id });
    const btn = el("button", {
      class: "recent-row",
      type: "button",
      "aria-label": `${t("recent.open")} ${p.title || p.id}`,
    });
    btn.append(el("span", { class: "recent-arrow", "aria-hidden": "true" }, ">"));
    btn.append(el("span", { class: "recent-name" }, p.title || p.id));
    btn.append(el("span", { class: "recent-tag" }, p.source_type));
    const date = fmtDate(p.created_at);
    if (date) btn.append(el("span", { class: "recent-date" }, date));
    btn.addEventListener("click", () => loadPaper(p.id));
    // 删除钮（独立于主行 btn，不影响点选打开）。
    const del = el("button", {
      class: "recent-del",
      type: "button",
      "aria-label": `${t("recent.delete.aria")} ${p.title || p.id}`,
      title: t("recent.delete.aria"),
    });
    del.append(trashSvg());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteConfirm(p);
    });
    li.append(btn, del);
    return li;
  }

  // 删除确认对话框（莫模 + 卡片，Esc/取消关闭，确认才真删）。
  async function openDeleteConfirm(p: PaperListItem) {
    const overlay = el("div", { class: "confirm-overlay", "data-open": "1", role: "dialog", "aria-modal": "true" });
    const card = el("div", { class: "confirm-card" });
    const title = p.title || p.id;
    card.append(el("p", { class: "confirm-msg" }, `${t("recent.delete.confirmPrefix")}《${title}》${t("recent.delete.confirmSuffix")}`));
    card.append(el("p", { class: "confirm-warn", "data-i18n": "recent.delete.irreversible" }, t("recent.delete.irreversible")));
    const row = el("div", { class: "confirm-row" });
    const cancel = el("button", { class: "note-act confirm-cancel", type: "button" }, t("recent.delete.cancel"));
    const ok = el("button", { class: "confirm-ok", type: "button" }, t("recent.delete.confirm"));
    row.append(cancel, ok);
    card.append(row);
    overlay.append(card);
    document.body.append(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    cancel.addEventListener("click", close);
    setTimeout(() => (cancel as HTMLButtonElement).focus(), 40);

    ok.addEventListener("click", async () => {
      (ok as HTMLButtonElement).disabled = true;
      (cancel as HTMLButtonElement).disabled = true;
      ok.textContent = t("recent.delete.deleting");
      try {
        await deletePaper(p.id);
        // 清 localStorage 若指向被删篇
        if (getLastPaper() === p.id) {
          try {
            localStorage.removeItem(LAST_PAPER_KEY);
          } catch {
            /* ignore */
          }
        }
        close();
        // 删的是当前正看的那篇 → 清空回列表；否则局部移除该项。
        if (current && current.paper_id === p.id) {
          await showPapersLibrary();
        } else {
          recentPapers = recentPapers.filter((x) => x.id !== p.id);
          const li = stream.querySelector(`.recent-item[data-paper="${CSS.escape(p.id)}"]`);
          if (li) li.remove();
          // 删完列表空了 → 显示空态
          if (!recentPapers.length && !current) stream.replaceChildren(renderRecentList([]));
        }
      } catch (err) {
        (ok as HTMLButtonElement).disabled = false;
        (cancel as HTMLButtonElement).disabled = false;
        ok.textContent = t("recent.delete.confirm");
        const errLine = card.querySelector(".confirm-err");
        if (errLine) errLine.remove();
        card.append(
          el("p", { class: "confirm-err" }, err instanceof ApiError ? `// ${err.message}` : `// ${String(err)}`),
        );
      }
    });
  }

  async function showRecent() {
    // 空工作区：渲染最近导入列表。失败不阻断（保留原 空状提示）。
    if (current) return;
    stream.replaceChildren(
      el("p", { class: "empty-hint recent-loading", "data-i18n": "recent.loading" }, t("recent.loading")),
    );
    try {
      const { papers } = await listPapers(30);
      if (current) return; // 加载期间已打开某 paper，丢弃
      stream.replaceChildren(renderRecentList(papers));
    } catch (e) {
      if (current) return;
      stream.replaceChildren(
        el(
          "p",
          { class: "empty-hint recent-fail" },
          `${t("recent.failPrefix")}${e instanceof ApiError ? e.message : String(e)}`,
        ),
      );
    }
  }

  // ── F2 fix：论文库入口——打开论文后也能随时调出列表切换。
  // 点 topbar「papers」钮 → 重置 current + 清空工作区 + 渲染最近列表（不受 if(current)return 拦截）。
  async function showPapersLibrary() {
    // 重置为空工作区状态（不动 localStorage，下次进站仍恢复上次；选了新篇才覆盖）。
    current = null;
    blockEls.clear();
    titleEl.textContent = t("paper.none");
    document.title = "research · 论文精读工作台";
    tocPane.replaceChildren();
    transBtn.disabled = true;
    progress.textContent = "";
    setStatus("", "info");
    await showRecent();
  }

  // 按 id 加载一篇已导入论文（最近列表点击 / 进站恢复公用）。
  async function loadPaper(paperId: string) {
    setStatus(t("status.parsing"));
    try {
      paint(await getView(paperId));
      setStatus("", "ok");
    } catch (e) {
      // 恢复失败（如 paper 已不在）：不报错坚，回退到最近列表。
      const stale = e instanceof ApiError && e.status === 404;
      if (stale && getLastPaper() === paperId) {
        try {
          localStorage.removeItem(LAST_PAPER_KEY);
        } catch {
          /* ignore */
        }
      }
      setStatus(
        e instanceof ApiError ? `${t("status.importFailPrefix")}${e.message}` : String(e),
        "error",
      );
      await showRecent();
    }
  }

  function updateProgress() {
    if (!current) return;
    const { translated, translatable } = current.stats;
    progress.textContent = `${translated} / ${translatable}${t("progress.translatedSuffix")}`;
    progress.dataset.done = translatable > 0 && translated >= translatable ? "1" : "0";
    transBtn.disabled = translated >= translatable;
  }

  // F8：导入逻辑抽离为纯函数，dialog 与（兜底）顶栏共用。
  //   返回 true=成功，便于 dialog 成功后自关。arxiv 解析路径零回归。
  async function doImport(raw: string): Promise<boolean> {
    const input = raw.trim();
    if (!input) return false;
    importBtn.disabled = true;
    setStatus(t("status.parsing"));
    try {
      // 解析在浏览器跑（用户 CPU，无 isolate CPU 墙）。
      //  ① 浏览器直接 fetch arXiv HTML / PDF → 本地切 block（block ID 与后端逐字一致）
      //  ② POST /api/import 交 worker 只校验+落库 → 返 ready
      //  ③ getView 拿对照视图渲染
      const parsed = await parseSourceClient(input);
      setStatus(t("status.saving"));
      const paper_id = parsed.arxiv_id ?? (await paperIdForClient(input));
      const res = await importParsed({
        paper_id,
        source_url: parsed.source_url,
        source_type: parsed.source_type,
        arxiv_id: parsed.arxiv_id,
        title: parsed.title,
        blocks: parsed.blocks,
        toc: parsed.toc,
      });
      const view = await getView(res.paper_id);
      setStatus(
        `${t("status.importedPrefix")}${view.stats.total}${t("status.importedBlocks")}${res.cached ? t("status.cached") : ""}`,
        "ok",
      );
      paint(view);
      return true;
    } catch (e) {
      const msg =
        e instanceof ParseClientError || e instanceof ApiError ? e.message : String(e);
      setStatus(`${t("status.importFailPrefix")}${msg}`, "error");
      return false;
    } finally {
      importBtn.disabled = false;
    }
  }

  // F8：导入弹框。复用站内 confirm-overlay/confirm-card（role=dialog
  //   aria-modal + Esc/遮罩取消 + terminal 配色）。输入框样式沿用 qa-input-row。
  //   提交走 doImport（arxiv 路径不变）；成功自关。多源 PDF 留扩展位（本单不实现）。
  let importDialogOpen = false;
  function openImportDialog(): void {
    if (importDialogOpen) return;
    importDialogOpen = true;
    const overlay = el("div", {
      class: "confirm-overlay import-overlay",
      "data-open": "1",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": t("import.dialog.title"),
    });
    const card = el("div", { class: "confirm-card import-card" });
    card.append(el("p", { class: "import-dialog-title" }, t("import.dialog.title")));
    card.append(el("p", { class: "confirm-msg import-dialog-hint" }, t("import.dialog.hint")));
    const inputRow = el("div", { class: "import-dialog-row" });
    inputRow.append(el("span", { class: "import-dialog-prefix", "aria-hidden": "true" }, ">"));
    const field = el("input", {
      class: "import-dialog-input",
      type: "text",
      id: "import-dialog-input",
      placeholder: t("import.placeholder"),
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    // 顶栏曾输入过的值带入，避免重输。
    if (importInput.value.trim()) field.value = importInput.value.trim();
    inputRow.append(field);
    card.append(inputRow);
    const row = el("div", { class: "confirm-row" });
    const cancel = el("button", { class: "note-act confirm-cancel", type: "button" }, t("import.dialog.cancel"));
    const ok = el("button", { class: "primary import-dialog-ok", type: "button" }, t("import.dialog.confirm"));
    row.append(cancel, ok);
    card.append(row);
    overlay.append(card);
    document.body.append(overlay);

    const close = () => {
      if (!importDialogOpen) return;
      importDialogOpen = false;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    cancel.addEventListener("click", close);

    const submit = async () => {
      const val = field.value.trim();
      if (!val) {
        field.focus();
        return;
      }
      ok.disabled = true;
      cancel.disabled = true;
      field.disabled = true;
      ok.textContent = t("import.dialog.importing");
      // 顶栏输入框同步（保留语义 + 兜底）。
      importInput.value = val;
      const okRes = await doImport(val);
      if (okRes) {
        close();
      } else {
        ok.disabled = false;
        cancel.disabled = false;
        field.disabled = false;
        ok.textContent = t("import.dialog.confirm");
        field.focus();
      }
    };
    ok.addEventListener("click", submit);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => field.focus(), 40);
  }

  async function doTranslateAll() {
    if (!current) return;
    transBtn.disabled = true;
    setStatus(t("status.translatingAll"));
    let lastTotal = 0;
    let lastRemaining = 0;
    let anyFailed = false;
    try {
      await translateAll(current.paper_id, (batch, totalDone) => {
        lastTotal = totalDone;
        lastRemaining = batch.remaining;
        if (batch.failed && batch.failed.length) anyFailed = true;
        // gateway 繁忙重试中的提示由 translateAll 内部退避接管；这里只刷进度。
        setStatus(
          `${t("status.batchPrefix")}${batch.translated.length}${t("status.batchTotal")}${totalDone}${batch.has_more ? t("status.batchMore") : t("status.batchDone")}`,
          batch.has_more ? "info" : "ok",
        );
      });
      paint(await getView(current.paper_id));
      if (anyFailed) {
        // 部分 block 重试仍败（批未抛但有 failed）→ 不报全成，留重试入口。
        setStatus(t("status.translateDone"), "info");
        transBtn.disabled = false;
      } else {
        setStatus(t("status.translateDone"), "ok");
      }
    } catch (e) {
      // F3-fix2：不整篇红错。已翻部分已进缓存 → 刷出已译，报“已翻 X 剩 Y 可重试”。
      //   gateway_error（平台 5xx，重试仍败）用可读文案；其他错原样。
      try {
        if (current) paint(await getView(current.paper_id));
      } catch {
        /* 刷新失败不遮掩原错 */
      }
      const isGateway = e instanceof ApiError && e.code === "gateway_error";
      if (lastTotal > 0 || lastRemaining > 0) {
        // 部分成功：报进度 + 可重试入口（再点翻译按钮走缓存补齐）。
        setStatus(
          `${t("status.translatePartialPrefix")}${lastTotal}${t("status.translatePartialMid")}${lastRemaining}${t("status.translatePartialSuffix")}`,
          "info",
        );
      } else {
        const msg =
          isGateway
            ? t("status.translateBusy")
            : e instanceof ApiError
              ? `${t("status.translateInterruptPrefix")}${e.message}`
              : `${t("status.translateInterruptPrefix")}${String(e)}`;
        setStatus(msg, "error");
      }
      transBtn.disabled = false;
    }
  }

  // ── 绑定 ──
  // F8：顶栏 import = 触发器。点按钮 / 点 readonly 输入框 / focus → 弹 dialog。
  //   readonly 防止顶栏直接键入（统一走 dialog），但仍保留输入框形态（视觉/等高不回退）。
  importInput.readOnly = true;
  importBtn.addEventListener("click", openImportDialog);
  importInput.addEventListener("click", openImportDialog);
  importInput.addEventListener("focus", openImportDialog);
  importInput.addEventListener("keydown", (e) => {
    // 键盘可达：Enter / Space / ↓ 在触发器上也弹 dialog。
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openImportDialog();
    }
  });
  transBtn.addEventListener("click", doTranslateAll);

  // F2 fix：papers 库钮 → 调出最近列表切换（打开论文后也能点）。
  papersBtn?.addEventListener("click", () => {
    // 已在库视图（无 current）且列表已在 → 不重复刷；否则调出。
    showPapersLibrary();
  });

  themeBtn.addEventListener("click", () => {
    theme = theme === "night" ? "day" : "night";
    applyTheme(theme);
    syncThemeBtn();
  });

  viewSeg.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (btn) setViewMode(btn.dataset.mode as ViewMode);
  });
  setViewMode("both");

  // ── F1 fix：共享划词选区菜单（问 AI + 记笔记同一菜单，不互盖）。
  //     必须在 mountQa / mountNotes 之前创建，供两者 register action。
  const selMenu = mountSelectionMenu(root);

  // ── M5「AI 问 paper」：仅初始化 QA UI，不动既有业务逻辑 ──
  mountQa(root, {
    getPaper: () => (current ? { paper_id: current.paper_id, blocks: current.blocks } : null),
    getLang: () => (viewMode === "en" ? "en" : "zh"),
    jumpTo,
    selMenu,
  });

  // ── F1「批注/笔记」：划词记笔记 + 书签 + 笔记面板，零侵入既有业务 ──
  mountNotes(root, {
    getPaper: () =>
      current
        ? {
            paper_id: current.paper_id,
            blocks: current.blocks.map((b) => ({ id: b.id, anchor: b.anchor, sec: b.sec })),
            toc: current.toc,
          }
        : null,
    jumpTo,
    selMenu,
  });

  // ── F4「思维导图」：顶栏按钮 → 全屏 markmap，零侵入既有业务 ──
  mountMindmap(root, {
    getPaper: () => (current ? { paper_id: current.paper_id } : null),
    getLang: () => (viewMode === "en" ? "en" : "zh"),
    jumpTo,
  });

  const pre = new URLSearchParams(location.search).get("paper");
  if (pre) {
    // URL ?paper= 优先级最高：作为 import 输入（可能是未导入的新 id）。
    importInput.value = pre;
    doImport(pre);
  } else {
    // 次优先：localStorage 上次打开的 paper 进站自动恢复；都没则渲染最近列表。
    const last = getLastPaper();
    if (last) loadPaper(last);
    else showRecent();
  }

  // ── M6 i18n：挂界面语言开关 + 首次 applyI18n + 监听切换重渲染动态文案 ──
  const uilangHost = $("#uilang-switch", root);
  if (uilangHost) mountUiLangSwitch(uilangHost);
  applyI18n(root, getUiLang());
  syncThemeBtn(); // theme aria 由 syncThemeBtn 动态拥有（指目标态），初始 applyI18n 后重刷避免被静态 theme.aria 覆盖
  window.addEventListener(UILANG_EVENT, () => {
    applyI18n(root, getUiLang());
    syncThemeBtn(); // theme label/aria 是 JS 动态写的，单独重刷
    updateProgress(); // progress 文案含 i18n 后缀
    selMenu.refreshI18n(); // F1 fix：选区菜单按钮文案（问 AI/记笔记）是 JS 动态写
    if (!current) showRecent(); // 空工作区最近列表是 JS 渲染，切语言重建
  });
}
