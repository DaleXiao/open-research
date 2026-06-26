// F4 思维导图（markmap 论文脑图）。reader.ts 仅调用 mountMindmap 一个入口，
// 既有业务（import/translate/对照/QA/批注/昼夜/中英）零侵入。
// 视觉延续 terminal：mono / 现有 token / 单色 currentColor SVG。
//
// 复用 notes 站教训（DESIGN §F4）：
//  - display:none 时 markmap autoloader 无法测量 → SVG width=0。故抽屉**可见后**再渲染。
//  - 切语言/重开：销毁旧 SVG + 重建（svg.remove → 新建 svg → Transformer.transform → Markmap.create）。
//  - markmap 资源：CDN autoloader（Base.astro 注入），window.markmap = { Transformer, Markmap }。

import { ApiError, mindmap, type MindmapLang } from "./api";
import { applyI18n, getUiLang, t, UILANG_EVENT } from "./i18n";

export interface MindmapDeps {
  /** 当前论文（含 paper_id；无 paper 返回 null）。 */
  getPaper: () => { paper_id: string } | null;
  /** 当前阅读语言（both/zh→zh，en→en）。脑图语言跟随。 */
  getLang: () => MindmapLang;
  /** 复用 reader 锚点跳转（节点带 section 引用时）。 */
  jumpTo: (anchor: string) => void;
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

// markmap autoloader 异步加载；等 window.markmap 就绪（最多 ~8s）。
type MarkmapGlobal = {
  Transformer: new () => { transform: (md: string) => { root: unknown } };
  Markmap: { create: (svg: SVGElement, opts: unknown, root: unknown) => unknown };
};
function waitForMarkmap(timeoutMs = 8000): Promise<MarkmapGlobal> {
  const w = window as unknown as { markmap?: MarkmapGlobal };
  if (w.markmap?.Transformer && w.markmap?.Markmap) return Promise.resolve(w.markmap);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const mk = (window as unknown as { markmap?: MarkmapGlobal }).markmap;
      if (mk?.Transformer && mk?.Markmap) return resolve(mk);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("markmap_cdn_timeout"));
      setTimeout(tick, 120);
    };
    tick();
  });
}

export function mountMindmap(root: HTMLElement, deps: MindmapDeps): void {
  const openBtn = root.querySelector<HTMLButtonElement>("#mindmap-open");
  const overlay = root.querySelector<HTMLElement>("#mindmap-overlay");
  const closeBtn = root.querySelector<HTMLButtonElement>("#mindmap-close");
  const regenBtn = root.querySelector<HTMLButtonElement>("#mindmap-regen");
  const stage = root.querySelector<HTMLElement>("#mindmap-stage");
  const statusEl = root.querySelector<HTMLElement>("#mindmap-status");
  if (!openBtn || !overlay || !closeBtn || !stage) return;

  // 当前已渲染的 markmap_md 与语言缓存（前端层，避免切语言来回打后端）。
  let currentSvg: SVGElement | null = null;
  // 已生成的 md 按 lang 前端缓存（后端也缓存，这层省一次往返）。
  const mdCache = new Map<MindmapLang, string>();
  let renderedLang: MindmapLang | null = null;
  // F3-fix3：缓存所属论文。切论文后 mdCache/renderedLang 必须失效，
  //   否则 generate() 会命中旧论文 md 直接 renderMd（不看新 paper_id）。
  let cachedPaperId: string | null = null;
  let busy = false;

  function setStatus(msg: string, kind: "info" | "error" | "ok" = "info") {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.dataset.kind = kind;
  }

  function destroySvg() {
    if (currentSvg) {
      currentSvg.remove();
      currentSvg = null;
    }
    // 兜底：清掉 stage 内任何残留 svg（防 autoloader 自渲染）。
    stage!.querySelectorAll("svg").forEach((s) => s.remove());
  }

  // 渲染一段 markmap markdown 到全新 SVG（销毁旧的，避免 display:none 测量 0 宽）。
  async function renderMd(md: string, lang: MindmapLang) {
    const mk = await waitForMarkmap();
    destroySvg();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mindmap-svg");
    stage!.append(svg);
    currentSvg = svg as unknown as SVGElement;
    const transformer = new mk.Transformer();
    const { root: mmRoot } = transformer.transform(md);
    // terminal 配色 + 适配容器：默认 autoFit。color 由 CSS 覆盖 .markmap-* stroke。
    mk.Markmap.create(svg as unknown as SVGElement, { autoFit: true, duration: 200 }, mmRoot);
    renderedLang = lang;
    bindNodeJump(svg as unknown as SVGElement);
  }

  // 节点带 [S2] / #anchor 形式 section 引用时，点击 jumpTo。markmap 渲染成 <a> 或文本节点，
  // 这里 best-effort：扫 svg 内文本含 [sxx] 模式的节点，点击滚动到对应 block anchor。
  function bindNodeJump(svg: SVGElement) {
    svg.querySelectorAll("g.markmap-node, g").forEach((g) => {
      const txt = g.textContent || "";
      const m = txt.match(/\[(?:#|sec-)?([A-Za-z0-9._-]+)\]/);
      if (!m) return;
      (g as SVGElement).style.cursor = "pointer";
      g.addEventListener("click", (e) => {
        // markmap 自身有展开/折叠点击；只在带引用时额外跳转，不阻止默认折叠。
        const anchor = m[1].startsWith("sec-") ? m[1] : `sec-${m[1]}`;
        deps.jumpTo(anchor);
        e.stopPropagation();
      });
    });
  }

  // F3-fix3：切论文失效。清 mdCache/renderedLang + 销毁旧 SVG，下次 generate
  //   强制重生成（看新 paper_id）。cachedPaperId 同步。
  function invalidateForPaper(paperId: string | null) {
    cachedPaperId = paperId;
    mdCache.clear();
    renderedLang = null;
    destroySvg();
  }

  // 生成（或取缓存）当前语言脑图并渲染。force=true 跳后端缓存重生成。
  async function generate(force = false) {
    const paper = deps.getPaper();
    if (!paper) {
      setStatus(t("mindmap.needPaper"), "error");
      return;
    }
    // F3-fix3 防御：若 paper 变了但事件漏接（干套）→ 这里兑底失效。
    if (paper.paper_id !== cachedPaperId) {
      invalidateForPaper(paper.paper_id);
    }
    const lang = deps.getLang();
    if (busy) return;
    // 前端缓存命中且非强制且语言一致 → 直接渲染。
    if (!force && mdCache.has(lang)) {
      try {
        await renderMd(mdCache.get(lang)!, lang);
        setStatus(t("mindmap.cached"), "ok");
      } catch {
        setStatus(t("mindmap.cdnFail"), "error");
      }
      return;
    }
    busy = true;
    if (regenBtn) regenBtn.disabled = true;
    setStatus(t("mindmap.generating"));
    try {
      const res = await mindmap(paper.paper_id, { lang, force });
      mdCache.set(res.lang, res.markmap_md);
      await renderMd(res.markmap_md, res.lang);
      setStatus(res.cached && !force ? t("mindmap.cached") : t("mindmap.done"), "ok");
    } catch (e) {
      if ((e as Error).message === "markmap_cdn_timeout") {
        setStatus(t("mindmap.cdnFail"), "error");
      } else if (e instanceof ApiError) {
        setStatus(`${t("mindmap.failPrefix")}${e.message}`, "error");
      } else {
        setStatus(`${t("mindmap.failPrefix")}${String(e)}`, "error");
      }
    } finally {
      busy = false;
      if (regenBtn) regenBtn.disabled = false;
    }
  }

  function openOverlay() {
    overlay!.dataset.open = "1";
    overlay!.setAttribute("aria-hidden", "false");
    openBtn!.setAttribute("aria-expanded", "true");
    // 可见后再渲染（display:none 会让 markmap 测量 0 宽 → 空白）。
    // 当前语言已渲染则不重复；否则生成。
    const lang = deps.getLang();
    if (renderedLang === lang && currentSvg) return;
    // 帧后渲染，确保 overlay 已 layout（拿到非 0 宽高）。
    requestAnimationFrame(() => generate(false));
  }

  function closeOverlay() {
    overlay!.dataset.open = "0";
    overlay!.setAttribute("aria-hidden", "true");
    openBtn!.setAttribute("aria-expanded", "false");
  }

  openBtn.addEventListener("click", () => {
    if (overlay.dataset.open === "1") closeOverlay();
    else openOverlay();
  });
  closeBtn.addEventListener("click", closeOverlay);
  regenBtn?.addEventListener("click", () => generate(true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.dataset.open === "1") closeOverlay();
  });
  // 点遮罩空白处（非 stage 内）关闭。
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  // 切语言：若 overlay 开着，销毁重建对应语言脑图（DESIGN §F4 切语言销毁重建）。
  window.addEventListener(UILANG_EVENT, () => {
    applyI18n(root, getUiLang());
    if (overlay.dataset.open === "1") {
      const lang = deps.getLang();
      if (lang !== renderedLang) {
        destroySvg();
        requestAnimationFrame(() => generate(false));
      }
    }
  });

  // view 语言（both/zh/en）切换也可能改 deps.getLang()。reader 在 setViewMode 后
  // 不派发 UILANG_EVENT，故这里额外监听一个自定义事件由 reader 触发。
  window.addEventListener("research:viewlang", () => {
    if (overlay.dataset.open === "1") {
      const lang = deps.getLang();
      if (lang !== renderedLang) {
        destroySvg();
        requestAnimationFrame(() => generate(false));
      }
    }
  });

  // F3-fix3：切论文统一失效信号。reader paint 新 paper 后广播，这里清缓存 +
  //   销毁旧 SVG。若 overlay 开着 → 重生成新论文脑图；没开则下次 open 时生成。
  window.addEventListener("research:paper-change", (e) => {
    const paperId = (e as CustomEvent<{ paperId?: string }>).detail?.paperId ?? null;
    if (paperId === cachedPaperId) return; // 同一篇（如翻译后 repaint）不清缓存
    invalidateForPaper(paperId);
    if (overlay.dataset.open === "1") {
      requestAnimationFrame(() => generate(false));
    }
  });

  applyI18n(root, getUiLang());
}
