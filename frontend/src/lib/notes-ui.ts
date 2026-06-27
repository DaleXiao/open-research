// 「批注/笔记」UI 层（F1）。reader.ts 仅调用 mountNotes 一个入口。
// 视觉严格延续 M4 terminal + 复用 qa-ui 套路：mono 字体 / 现有终端 token / 单色 currentColor SVG。
// 功能：划词 → 浮钮「+ note」→ 小卡输 note_md → 存 block_id + quote_snapshot + sel_start/end；
//       有笔记 block 左 gutter 书签标识 + ToC 章节标记；笔记面板（右抽屉）列出+跳转锚定；编辑/删除。

import {
  ApiError,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
  type Annotation,
} from "./api";
import { applyI18n, getUiLang, t, UILANG_EVENT } from "./i18n";
import type { SelectionMenu, SelectionPick } from "./selection-menu";

export interface NotesDeps {
  /** 当前论文视图（paper_id + blocks 含 sec 用于 ToC 标记）。无 paper 返回 null。 */
  getPaper: () => {
    paper_id: string;
    blocks: { id: string; anchor: string; sec: string }[];
    toc: { id: string }[];
  } | null;
  /** 复用 reader 的锚点跳转。 */
  jumpTo: (anchor: string) => void;
  /** F1 fix：共享划词选区菜单（替代自画「+note」浮钮，不互盖）。 */
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

function svgIcon(paths: { d?: string; tag?: "path" | "polyline"; points?: string }[]): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const p of paths) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", p.tag || "path");
    if (p.d) node.setAttribute("d", p.d);
    if (p.points) node.setAttribute("points", p.points);
    svg.append(node);
  }
  return svg;
}

// 书签 SVG（terminal 绿，单色 currentColor）。
function bookmarkSvg(): SVGElement {
  return svgIcon([{ d: "M6 3h12v18l-6-4-6 4V3z" }]);
}

export function mountNotes(root: HTMLElement, deps: NotesDeps): void {
  const drawer = root.querySelector<HTMLElement>("#notes-drawer");
  const openBtn = root.querySelector<HTMLButtonElement>("#notes-open");
  const closeBtn = root.querySelector<HTMLButtonElement>("#notes-close");
  const listPane = root.querySelector<HTMLElement>("#notes-list");
  const countBadge = root.querySelector<HTMLElement>("#notes-count");
  if (!drawer || !openBtn || !closeBtn || !listPane) return;

  const stream = root.querySelector<HTMLElement>("#stream");

  // 当前 paper 的批注（内存镜像，按 created_at ASC）。
  let annotations: Annotation[] = [];
  let loadedFor: string | null = null;

  // ── 书签 gutter：有笔记的 block 左侧渲染书签 SVG，hover 显「N 条笔记」 ──
  function blockNoteCount(): Map<string, number> {
    const m = new Map<string, number>();
    for (const a of annotations) m.set(a.block_id, (m.get(a.block_id) || 0) + 1);
    return m;
  }

  function clearBookmarks() {
    if (!stream) return;
    for (const mk of stream.querySelectorAll(".note-bookmark")) mk.remove();
    for (const b of stream.querySelectorAll("[data-has-note]")) b.removeAttribute("data-has-note");
  }

  function renderBookmarks() {
    if (!stream) return;
    clearBookmarks();
    const counts = blockNoteCount();
    for (const [blockId, n] of counts) {
      const blk = stream.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
      if (!blk) continue;
      blk.setAttribute("data-has-note", "1");
      const mk = el("button", {
        class: "note-bookmark",
        type: "button",
        title: `${n} ${t("note.bookmark.count")}`,
        "aria-label": `${n} ${t("note.bookmark.count")}`,
      });
      mk.append(bookmarkSvg());
      // 点击书签 → 打开抽屉并跳到该 block 第一条笔记
      mk.addEventListener("click", (e) => {
        e.stopPropagation();
        openDrawer(false);
        const first = annotations.find((a) => a.block_id === blockId);
        if (first) highlightNoteCard(first.id);
      });
      blk.prepend(mk);
    }
    renderTocMarks(counts);
  }

  // ── ToC 章节标记：该 section 下有笔记 → ToC 对应项加提示点 ──
  function renderTocMarks(counts: Map<string, number>) {
    const tocPane = root.querySelector<HTMLElement>("#toc");
    if (!tocPane) return;
    for (const dot of tocPane.querySelectorAll(".toc-note-dot")) dot.remove();
    const paper = deps.getPaper();
    if (!paper) return;
    // 收集有笔记的 section id 集合
    const secWithNotes = new Set<string>();
    const byId = new Map(paper.blocks.map((b) => [b.id, b]));
    for (const blockId of counts.keys()) {
      const b = byId.get(blockId);
      if (b?.sec) secWithNotes.add(b.sec);
    }
    if (!secWithNotes.size) return;
    // ToC 链接 href="#<sectionId>"，匹配 section id
    for (const a of tocPane.querySelectorAll<HTMLAnchorElement>("a[href^='#']")) {
      const sid = decodeURIComponent(a.getAttribute("href")!.slice(1));
      if (secWithNotes.has(sid)) {
        a.append(el("span", { class: "toc-note-dot", "aria-hidden": "true" }, "•"));
      }
    }
  }

  // ── 笔记卡渲染 ──
  function noteJump(blockId: string) {
    const paper = deps.getPaper();
    const blk = paper?.blocks.find((x) => x.id === blockId);
    if (blk) {
      deps.jumpTo(blk.anchor);
    } else {
      stream
        ?.querySelector(`[data-block="${CSS.escape(blockId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    flashBlock(blockId);
  }

  function flashBlock(blockId: string) {
    const blk = stream?.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
    if (!blk) return;
    blk.classList.remove("note-flash");
    // 强制 reflow 以便重复触发动画
    void blk.offsetWidth;
    blk.classList.add("note-flash");
    setTimeout(() => blk.classList.remove("note-flash"), 1600);
  }

  function renderNoteCard(a: Annotation): HTMLElement {
    const item = el("div", { class: "note-item" });
    item.dataset.id = a.id;
    // 引文（quote_snapshot）
    if (a.quote_snapshot) {
      const quote = el("blockquote", { class: "note-quote" });
      quote.append(el("span", { class: "note-quote-prefix", "aria-hidden": "true" }, "> "), a.quote_snapshot);
      quote.addEventListener("click", () => noteJump(a.block_id));
      quote.title = `${t("note.jumpPrefix")}${a.block_id}`;
      item.append(quote);
    }
    // 正文
    const body = el("div", { class: "note-body" }, a.note_md);
    item.append(body);
    // 操作行：跳转 / 编辑 / 删除
    const actions = el("div", { class: "note-actions" });
    const jumpBtn = el("button", { class: "note-act", type: "button", title: `${t("note.jumpPrefix")}${a.block_id}` }, t("note.jump"));
    jumpBtn.addEventListener("click", () => noteJump(a.block_id));
    const editBtn = el("button", { class: "note-act", type: "button" }, t("note.edit"));
    editBtn.addEventListener("click", () => startEdit(item, a));
    const delBtn = el("button", { class: "note-act note-act-danger", type: "button" }, t("note.delete"));
    delBtn.addEventListener("click", () => doDelete(a));
    actions.append(jumpBtn, editBtn, delBtn);
    item.append(actions);
    return item;
  }

  function startEdit(item: HTMLElement, a: Annotation) {
    if (item.querySelector(".note-edit-form")) return;
    const body = item.querySelector<HTMLElement>(".note-body");
    const actions = item.querySelector<HTMLElement>(".note-actions");
    if (!body || !actions) return;
    body.hidden = true;
    actions.hidden = true;
    const form = el("form", { class: "note-edit-form" });
    const ta = el("textarea", { class: "note-edit-ta", rows: "3" }) as HTMLTextAreaElement;
    ta.value = a.note_md;
    const row = el("div", { class: "note-edit-row" });
    const save = el("button", { class: "primary note-edit-save", type: "submit" }, t("note.save"));
    const cancel = el("button", { class: "note-act", type: "button" }, t("note.cancel"));
    row.append(save, cancel);
    form.append(ta, row);
    item.append(form);
    setTimeout(() => ta.focus(), 30);
    cancel.addEventListener("click", () => {
      form.remove();
      body.hidden = false;
      actions.hidden = false;
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      const paper = deps.getPaper();
      if (!paper) return;
      (save as HTMLButtonElement).disabled = true;
      try {
        const res = await updateAnnotation(paper.paper_id, a.id, text);
        const idx = annotations.findIndex((x) => x.id === a.id);
        if (idx >= 0) annotations[idx] = res.annotation;
        item.replaceWith(renderNoteCard(res.annotation));
      } catch (err) {
        (save as HTMLButtonElement).disabled = false;
        showFormError(form, err);
      }
    });
  }

  async function doDelete(a: Annotation) {
    const paper = deps.getPaper();
    if (!paper) return;
    try {
      await deleteAnnotation(paper.paper_id, a.id);
      annotations = annotations.filter((x) => x.id !== a.id);
      renderList();
      renderBookmarks();
    } catch (err) {
      // 失败时在抽屉顶部提示
      const banner = el("p", { class: "note-empty note-err" }, err instanceof ApiError ? `// ${err.message}` : `// ${String(err)}`);
      listPane!.prepend(banner);
      setTimeout(() => banner.remove(), 3000);
    }
  }

  function showFormError(form: HTMLElement, err: unknown) {
    const old = form.querySelector(".note-form-err");
    if (old) old.remove();
    form.append(el("p", { class: "note-form-err" }, err instanceof ApiError ? `// ${err.message}` : `// ${String(err)}`));
  }

  function renderList() {
    listPane!.replaceChildren();
    if (countBadge) countBadge.textContent = annotations.length ? String(annotations.length) : "";
    if (!annotations.length) {
      listPane!.append(el("p", { class: "note-empty" }, t("note.empty.none")));
      return;
    }
    for (const a of annotations) listPane!.append(renderNoteCard(a));
  }

  function highlightNoteCard(id: string) {
    const card = listPane!.querySelector<HTMLElement>(`.note-item[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("note-card-flash");
    void card.offsetWidth;
    card.classList.add("note-card-flash");
    setTimeout(() => card.classList.remove("note-card-flash"), 1600);
  }

  async function loadAnnotations(force = false) {
    const paper = deps.getPaper();
    if (!paper) {
      annotations = [];
      loadedFor = null;
      renderList();
      clearBookmarks();
      if (countBadge) countBadge.textContent = "";
      return;
    }
    if (!force && loadedFor === paper.paper_id) return;
    listPane!.replaceChildren(el("p", { class: "note-empty" }, t("note.empty.loading")));
    try {
      const res = await listAnnotations(paper.paper_id);
      annotations = res.annotations;
      loadedFor = paper.paper_id;
      renderList();
      renderBookmarks();
    } catch (e) {
      listPane!.replaceChildren(
        el("p", { class: "note-empty note-err" }, e instanceof ApiError ? `// ${e.message}` : `// ${String(e)}`),
      );
    }
  }

  function openDrawer(focus = true) {
    drawer!.dataset.open = "1";
    drawer!.setAttribute("aria-hidden", "false");
    openBtn!.setAttribute("aria-expanded", "true");
    loadAnnotations();
    if (focus) setTimeout(() => listPane!.scrollTo({ top: listPane!.scrollHeight }), 60);
  }
  function closeDrawer() {
    drawer!.dataset.open = "0";
    drawer!.setAttribute("aria-hidden", "true");
    openBtn!.setAttribute("aria-expanded", "false");
  }

  openBtn.addEventListener("click", () => {
    if (drawer.dataset.open === "1") closeDrawer();
    else openDrawer();
  });
  closeBtn.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (noteCard.dataset.open === "1") return closeNoteCard();
      if (drawer.dataset.open === "1") closeDrawer();
    }
  });

  // ── F1 fix：注册到共享划词选区菜单的「记笔记」项（不再自画「+note」浮钮）──
  // 选中文字 → 菜单出「问 AI」+「记笔记」两项并排，点「记笔记」→ 开输入小卡。
  deps.selMenu.register({
    id: "note",
    labelKey: "note.selbtn.label",
    ariaKey: "note.selbtn.aria",
    icon: bookmarkSvg,
    onPick: (pick: SelectionPick) => {
      openNoteCard({
        blockId: pick.blockId,
        text: pick.text,
        selStart: pick.selStart,
        selEnd: pick.selEnd,
      });
    },
  });

  // ── 输入小卡（划词后弹出，输 note_md）──
  const noteCard = el("div", { class: "note-card", "data-open": "0" });
  const ncQuote = el("blockquote", { class: "note-card-quote" });
  const ncForm = el("form", { class: "note-card-form" });
  const ncTa = el("textarea", {
    class: "note-card-ta",
    rows: "3",
    placeholder: t("note.card.placeholder"),
    "data-i18n-attr": "placeholder:note.card.placeholder",
  }) as HTMLTextAreaElement;
  const ncRow = el("div", { class: "note-card-row" });
  const ncSave = el("button", { class: "primary note-card-save", type: "submit" }, t("note.save"));
  const ncCancel = el("button", { class: "note-act", type: "button" }, t("note.cancel"));
  ncRow.append(ncSave, ncCancel);
  ncForm.append(ncTa, ncRow);
  noteCard.append(ncQuote, ncForm);
  document.body.append(noteCard);

  let cardSel: { blockId: string; text: string; selStart: number | null; selEnd: number | null } | null = null;

  function openNoteCard(s: { blockId: string; text: string; selStart: number | null; selEnd: number | null }) {
    cardSel = s;
    ncQuote.textContent = s.text.length > 160 ? s.text.slice(0, 160) + "…" : s.text;
    ncTa.value = "";
    // 定位：尽量靠近当前选区 rect（菜单已隐，选区可能还在）；拿不到则居中靠上。
    let top = window.scrollY + 80;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) top = window.scrollY + r.bottom + 8;
    }
    noteCard.style.top = `${top}px`;
    noteCard.style.left = "";
    noteCard.dataset.open = "1";
    setTimeout(() => ncTa.focus(), 40);
  }
  function closeNoteCard() {
    noteCard.dataset.open = "0";
    cardSel = null;
    const oldErr = ncForm.querySelector(".note-form-err");
    if (oldErr) oldErr.remove();
  }
  ncCancel.addEventListener("click", closeNoteCard);
  ncForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ncTa.value.trim();
    if (!text || !cardSel) return;
    const paper = deps.getPaper();
    if (!paper) {
      closeNoteCard();
      return;
    }
    ncSave.disabled = true;
    try {
      const res = await createAnnotation(paper.paper_id, {
        block_id: cardSel.blockId,
        note_md: text,
        quote_snapshot: cardSel.text.slice(0, 2000),
        sel_start: cardSel.selStart,
        sel_end: cardSel.selEnd,
      });
      annotations.push(res.annotation);
      loadedFor = paper.paper_id;
      renderList();
      renderBookmarks();
      closeNoteCard();
      openDrawer(false);
      highlightNoteCard(res.annotation.id);
    } catch (err) {
      ncSave.disabled = false;
      showFormError(ncForm, err);
    } finally {
      ncSave.disabled = false;
    }
  });

  // ── 公开：reader paint 后调用，重载批注 + 重渲书签（重渲染重锚靠 block_id）──
  (root as any).__notesReload = () => loadAnnotations(true);

  // ── i18n：初始 + 监听切换 ──
  applyI18n(root, getUiLang());
  window.addEventListener(UILANG_EVENT, () => {
    applyI18n(root, getUiLang());
    // 选区菜单按钮文案由共享 selMenu 刷新（reader 统一调）。
    ncTa.setAttribute("placeholder", t("note.card.placeholder"));
    renderList();
    renderBookmarks();
  });
}
