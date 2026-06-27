// 界面 UI 语言切换 i18n（M6）。零依赖纯字典 + key 渲染。
// 与「译文显隐 both/zh/en」（内容层）正交独立：此处只切 UI chrome 文案。
// 模式严格沿用 research.theme（昼夜）：localStorage 持久化 + paint 前防闪 + CustomEvent 广播。

export type UiLang = "zh" | "en";

export const UILANG_KEY = "research.uiLang";
export const UILANG_EVENT = "uilang-change";

// ── 字典：zh / en 两套 key 集合必须完全一致（DoD#2）。≥30 key。 ──
export const messages: Record<UiLang, Record<string, string>> = {
  zh: {
    // 顶栏
    "brand.tagline": "论文精读 · 中英对照",
    "import.placeholder": "arXiv id 或链接，例 1706.03762",
    "import.btn": "导入",
    "import.trigger.aria": "点击导入论文",
    "import.dialog.title": "导入论文",
    "import.dialog.hint": "输入 arXiv id / 链接，或 PDF 论文 URL（例 1706.03762）",
    "import.dialog.confirm": "导入",
    "import.dialog.cancel": "取消",
    "import.dialog.importing": "导入中…",
    "qa.open": "问 paper",
    "qa.open.aria": "AI 问 paper",
    "papers.open": "论文库",
    "papers.open.aria": "论文库 · 切换已导入论文",
    "theme.aria": "切换昼夜",
    "theme.night": "夜",
    "theme.day": "昼",
    "theme.toNight": "切换到夜间",
    "theme.toDay": "切换到日间",
    "uilang.aria": "界面语言",
    // 侧栏 / 目录
    "toc.aria": "目录",
    "paper.none": "// 未载入论文",
    // 工具栏
    "translate.btn": "翻译全文",
    "view.aria": "显示语言",
    "view.both": "对照",
    "view.zh": "仅中",
    "view.en": "仅英",
    "empty.hint": "导入一篇 arXiv 论文开始精读。公式与图表原样保留，译文按段懒翻——可整篇翻译，也可逐段点 [译]。",
    // 最近论文（F2 进站恢复）
    "recent.title": "最近导入",
    "recent.empty": "// 还没导入过论文 — 在上方输入 arXiv id 开始",
    "recent.open": "打开",
    "recent.loading": "// 加载最近记录中…",
    "recent.failPrefix": "// 最近记录加载失败：",
    "recent.blocksSuffix": " 块",
    "recent.delete.aria": "删除论文",
    "recent.delete.confirmPrefix": "确定删除",
    "recent.delete.confirmSuffix": "？",
    "recent.delete.irreversible": "此操作不可恢复，译文/笔记/问答/脑图将一并清除。",
    "recent.delete.cancel": "取消",
    "recent.delete.confirm": "删除",
    "recent.delete.deleting": "删除中…",
    "translate.one.label": "译",
    "translate.one.title": "翻译此段",
    "translate.one.loading": "翻译中…",
    "translate.one.retry": "重试",
    "zh.placeholder": "待翻译",
    // 状态行（动态拼接，部分作前缀/后缀）
    "status.parsing": "解析中…",
    "status.saving": "保存中…",
    "status.importedPrefix": "已导入：",
    "status.importedBlocks": " 块",
    "status.cached": "（缓存）",
    "status.translatingAll": "翻译全文中…（后端分批，公式保留）",
    "status.batchPrefix": "本批 +",
    "status.batchTotal": "，累计 ",
    "status.batchMore": "，继续…",
    "status.batchDone": "，完成",
    "status.translateDone": "全文翻译完成",
    "status.importFailPrefix": "导入失败：",
    "status.translateInterruptPrefix": "翻译中断：",
    "status.translateBusy": "翻译服务繁忙，正在重试…",
    "status.translatePartialPrefix": "已翻 ",
    "status.translatePartialMid": " 段，剩余 ",
    "status.translatePartialSuffix": " 段可重试（再点翻译继续）",
    "status.paraFailPrefix": "本段翻译失败：",
    "progress.translatedSuffix": " 段已译",
    // 问答抽屉
    "qa.title": "问 paper",
    "qa.close.aria": "关闭",
    "qa.empty.import": "// 请先导入论文",
    "qa.empty.none": "// 还没有提问 — 在下方提问",
    "qa.empty.loading": "// 加载历史中…",
    "qa.scope.aria": "问答范围",
    "qa.scope.full": "全文",
    "qa.scope.selection": "选区",
    "qa.input.placeholder": "就这篇论文随便问…",
    "qa.send": "发送",
    "qa.send.aria": "发送",
    "qa.cited.label": "引用：",
    "qa.jumpPrefix": "跳到 ",
    "qa.selbtn.aria": "就选中文字提问",
    "qa.selbtn.label": "问 AI",
    "qa.sel.need": "// 先在阅读区选中一段文字",
    "qa.sel.needSend": "// 请先在阅读区选中一段文字再发送",
    "qa.sel.prefix": "// 选区: ",
    "qa.needPaper": "// 请先导入论文",
    "qa.askFailPrefix": "// 提问失败：",
    "qa.error.timeout": "提问超时，请重试或换简短问题",
    "qa.error.gateway": "服务暂时不可用，请重试",
    "qa.error.generic": "提问失败",
    // 思维导图（F4）
    "mindmap.open": "脑图",
    "mindmap.open.aria": "生成论文思维导图",
    "mindmap.title": "思维导图",
    "mindmap.close.aria": "关闭脑图",
    "mindmap.regen": "重生成",
    "mindmap.regen.aria": "重新生成脑图",
    "mindmap.generating": "生成中…（qwen3.7-plus，注入 toc + 章节精华）",
    "mindmap.done": "脑图生成完成",
    "mindmap.cached": "脑图（缓存）",
    "mindmap.failPrefix": "脑图生成失败：",
    "mindmap.cdnFail": "markmap 资源加载失败，请重试",
    "mindmap.needPaper": "// 请先导入论文",
    // 批注/笔记（F1）
    "note.open": "笔记",
    "note.open.aria": "笔记面板",
    "note.title": "笔记",
    "note.close.aria": "关闭",
    "note.empty.none": "// 还没有笔记 — 在阅读区划词记笔记",
    "note.empty.loading": "// 加载笔记中…",
    "note.selbtn.aria": "就选中文字记笔记",
    "note.selbtn.label": "笔记",
    "note.card.placeholder": "写下你的笔记（markdown）…",
    "note.save": "保存",
    "note.cancel": "取消",
    "note.edit": "编辑",
    "note.delete": "删除",
    "note.jump": "跳转",
    "note.jumpPrefix": "跳到 ",
    "note.bookmark.count": "条笔记",
  },
  en: {
    // top bar
    "brand.tagline": "paper reader · bilingual",
    "import.placeholder": "arxiv id or url, e.g. 1706.03762",
    "import.btn": "import",
    "import.trigger.aria": "Click to import a paper",
    "import.dialog.title": "import paper",
    "import.dialog.hint": "enter arXiv id / url, or a PDF paper URL (e.g. 1706.03762)",
    "import.dialog.confirm": "import",
    "import.dialog.cancel": "cancel",
    "import.dialog.importing": "importing…",
    "qa.open": "ask",
    "qa.open.aria": "Ask paper",
    "papers.open": "papers",
    "papers.open.aria": "Paper library · switch imported papers",
    "theme.aria": "Toggle theme",
    "theme.night": "night",
    "theme.day": "day",
    "theme.toNight": "Switch to night",
    "theme.toDay": "Switch to day",
    "uilang.aria": "UI language",
    // sidebar / toc
    "toc.aria": "Table of contents",
    "paper.none": "// no paper loaded",
    // toolbar
    "translate.btn": "translate --all",
    "view.aria": "Display language",
    "view.both": "both",
    "view.zh": "zh",
    "view.en": "en",
    "empty.hint": "import an arXiv paper to begin. Math and figures are kept as-is; translations load lazily — translate the whole paper, or one paragraph at a time via [t].",
    // recent papers (F2 restore-on-enter)
    "recent.title": "recent",
    "recent.empty": "// no papers imported yet — enter an arXiv id above to begin",
    "recent.open": "open",
    "recent.loading": "// loading recent…",
    "recent.failPrefix": "// failed to load recent: ",
    "recent.blocksSuffix": " blocks",
    "recent.delete.aria": "Delete paper",
    "recent.delete.confirmPrefix": "Delete ",
    "recent.delete.confirmSuffix": "?",
    "recent.delete.irreversible": "This cannot be undone; translations/notes/Q&A/mindmaps are removed too.",
    "recent.delete.cancel": "Cancel",
    "recent.delete.confirm": "Delete",
    "recent.delete.deleting": "deleting…",
    "translate.one.label": "t",
    "translate.one.title": "Translate this paragraph",
    "translate.one.loading": "translating…",
    "translate.one.retry": "retry",
    "zh.placeholder": "pending",
    // status line (dynamic concat; some are prefix/suffix)
    "status.parsing": "parsing…",
    "status.saving": "saving…",
    "status.importedPrefix": "imported: ",
    "status.importedBlocks": " blocks",
    "status.cached": " (cached)",
    "status.translatingAll": "translating full paper… (batched on backend, math preserved)",
    "status.batchPrefix": "batch +",
    "status.batchTotal": ", total ",
    "status.batchMore": ", continuing…",
    "status.batchDone": ", done",
    "status.translateDone": "full translation done",
    "status.importFailPrefix": "import failed: ",
    "status.translateInterruptPrefix": "translation interrupted: ",
    "status.translateBusy": "translation service busy, retrying…",
    "status.translatePartialPrefix": "translated ",
    "status.translatePartialMid": " paragraphs, ",
    "status.translatePartialSuffix": " remaining (click translate again to continue)",
    "status.paraFailPrefix": "paragraph translation failed: ",
    "progress.translatedSuffix": " translated",
    // qa drawer
    "qa.title": "ask",
    "qa.close.aria": "Close",
    "qa.empty.import": "// import a paper first",
    "qa.empty.none": "// no questions yet — ask below",
    "qa.empty.loading": "// loading history…",
    "qa.scope.aria": "Scope",
    "qa.scope.full": "full",
    "qa.scope.selection": "selection",
    "qa.input.placeholder": "ask anything about this paper…",
    "qa.send": "send",
    "qa.send.aria": "Send",
    "qa.cited.label": "cited:",
    "qa.jumpPrefix": "jump to ",
    "qa.selbtn.aria": "Ask about selection",
    "qa.selbtn.label": "ask AI",
    "qa.sel.need": "// select text in the reading area first",
    "qa.sel.needSend": "// select text in the reading area before sending",
    "qa.sel.prefix": "// selection: ",
    "qa.needPaper": "// import a paper first",
    "qa.askFailPrefix": "// ask failed: ",
    "qa.error.timeout": "Request timed out, please retry or shorten the question",
    "qa.error.gateway": "Service temporarily unavailable, please retry",
    "qa.error.generic": "Ask failed",
    // mindmap (F4)
    "mindmap.open": "mindmap",
    "mindmap.open.aria": "Generate paper mindmap",
    "mindmap.title": "mindmap",
    "mindmap.close.aria": "Close mindmap",
    "mindmap.regen": "regenerate",
    "mindmap.regen.aria": "Regenerate mindmap",
    "mindmap.generating": "generating… (qwen3.7-plus, toc + section highlights)",
    "mindmap.done": "mindmap ready",
    "mindmap.cached": "mindmap (cached)",
    "mindmap.failPrefix": "mindmap failed: ",
    "mindmap.cdnFail": "failed to load markmap assets, please retry",
    "mindmap.needPaper": "// import a paper first",
    // annotations / notes (F1)
    "note.open": "notes",
    "note.open.aria": "Notes panel",
    "note.title": "notes",
    "note.close.aria": "Close",
    "note.empty.none": "// no notes yet — select text in the reader to take a note",
    "note.empty.loading": "// loading notes…",
    "note.selbtn.aria": "Note on selection",
    "note.selbtn.label": "note",
    "note.card.placeholder": "write your note (markdown)…",
    "note.save": "save",
    "note.cancel": "cancel",
    "note.edit": "edit",
    "note.delete": "delete",
    "note.jump": "jump",
    "note.jumpPrefix": "jump to ",
    "note.bookmark.count": "note(s)",
  },
};

// ── 取语言：localStorage → navigator.language 起始 zh → zh，否则 en ──
export function getUiLang(): UiLang {
  try {
    const saved = localStorage.getItem(UILANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* localStorage 不可用时回退 navigator */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

// ── 设置语言：写 localStorage + 同步 <html> + 派发 CustomEvent ──
export function setUiLang(lang: UiLang): void {
  try {
    localStorage.setItem(UILANG_KEY, lang);
  } catch {
    /* 忽略持久化失败 */
  }
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.setAttribute("lang", lang);
    root.setAttribute("data-uilang", lang);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<UiLang>(UILANG_EVENT, { detail: lang }));
  }
}

// ── 取字典文案：缺 key 返回 key 本身兜底 ──
export function t(key: string, lang: UiLang = getUiLang()): string {
  const dict = messages[lang] || messages.zh;
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
}

// ── 扫描并替换 DOM：[data-i18n]（textContent）+ [data-i18n-attr]（属性）──
export function applyI18n(root: ParentNode = document.body, lang: UiLang = getUiLang()): void {
  // textContent
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (key) node.textContent = t(key, lang);
  });
  // 属性：格式 "aria-label:key;placeholder:key"
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((node) => {
    const spec = node.getAttribute("data-i18n-attr") || "";
    for (const pair of spec.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx < 0) continue;
      const attr = trimmed.slice(0, idx).trim();
      const key = trimmed.slice(idx + 1).trim();
      if (attr && key) node.setAttribute(attr, t(key, lang));
    }
  });
}

// ── 渲染 [ 中 | EN ] terminal 分段控件（复用 .seg CSS 套路，不新增视觉 token）──
export function mountUiLangSwitch(host: HTMLElement): void {
  const cur = getUiLang();
  host.setAttribute("aria-label", t("uilang.aria", cur));
  host.setAttribute("data-i18n-attr", "aria-label:uilang.aria");
  host.replaceChildren();

  // 去掉 "ui:" 前缀标签，语言切换只留 中/EN。
  const defs: { lang: UiLang; label: string }[] = [
    { lang: "zh", label: "中" },
    { lang: "en", label: "EN" },
  ];
  const buttons: HTMLButtonElement[] = [];
  for (const d of defs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.uilang = d.lang;
    btn.textContent = d.label;
    btn.setAttribute("aria-pressed", d.lang === cur ? "true" : "false");
    btn.addEventListener("click", () => {
      if (getUiLang() === d.lang) return;
      setUiLang(d.lang);
      applyI18n(document.body, d.lang);
      syncPressed(d.lang);
    });
    buttons.push(btn);
    host.append(btn);
  }

  function syncPressed(lang: UiLang) {
    for (const b of buttons) {
      b.setAttribute("aria-pressed", b.dataset.uilang === lang ? "true" : "false");
    }
  }

  // 外部（如另一个开关、reload 同步）切换时也保持高亮一致
  window.addEventListener(UILANG_EVENT, (e) => {
    const lang = (e as CustomEvent<UiLang>).detail || getUiLang();
    syncPressed(lang);
  });
}
