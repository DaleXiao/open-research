# research-worker — backend

The Cloudflare Worker backend for the open-research reading workbench. It owns
the `/api/*` contract (papers, translation, annotations, Q&A, mind map) and is
backed by Cloudflare D1. The frontend (Astro on Cloudflare Pages) lives in
`../frontend` and takes over the same origin, so the browser calls relative
`/api/...` paths with no CORS.

> **LLM gateway not included.** All model calls (translation, embeddings, Q&A,
> mind map) are proxied through an external, OpenAI-compatible LLM gateway that
> is **not** part of this repository. You supply your own — see
> [LLM gateway](#llm-gateway) below.

## Architecture

```
browser (frontend) ──parses arXiv/PDF client-side──┐
                                                    ▼
            POST /api/import  { blocks[] }   →  validate + persist (D1)
            GET  /api/paper/:id              →  bilingual view (blocks + cached zh)
            POST /api/paper/:id/translate    →  lazy translate (cache-first) → LLM gateway
            POST /api/paper/:id/qa           →  RAG over blocks → LLM gateway
            POST /api/paper/:id/mindmap      →  markmap markdown → LLM gateway
            *    /api/paper/:id/annotations  →  CRUD notes anchored to blocks
            DELETE /api/paper/:id            →  cascade delete
            GET  /api/health                 →  ok
```

Parsing happens in the **browser** (the frontend parses arXiv LaTeXML HTML / PDF
into a stable block list). The Worker does **zero parsing and zero outbound
fetches to arXiv** — it validates the submitted blocks and stores them. This
keeps the Worker well under CPU limits.

### The block format

Every paper is represented as a list of stable-id blocks. All four features hang
off the block id: translation is per-block, annotations anchor to a block, Q&A
pulls block context, the mind map walks the section tree.

```ts
interface Block {
  id: string;        // stable id (reused from arXiv LaTeXML element ids when available)
  type: "para" | "math" | "figure" | "heading";
  sec: string;       // owning section id
  order: number;     // linear order across the whole paper, 0-based contiguous
  level: number;     // section depth (section=1, subsection=2, ...)
  text_en: string;   // source text; inline math kept as $latex$ placeholders
  text_zh: string|null; // lazy translation; null until translated
  latex: string|null;   // LaTeX for math blocks
  img_url: string|null; // absolute image url for figure/table blocks
  caption: string|null; // figure/table caption
  anchor: string;    // annotation / scroll anchor, defaults to == id
  translate: boolean;// false for math/figure (rendered as-is), true for prose/headings
}
```

`ParsedPaper` additionally carries `title / abstract / toc (section tree) / meta`.

### Translation & formula safety

- **math / figure blocks are never sent to the model** (`translate=false`); they
  render as-is from LaTeX / MathML.
- **inline formulas are masked → translated → unmasked** (`src/translate/mask.ts`):
  `$latex$` is swapped for stable sentinels before translation and restored
  after. Sentinel integrity is verified; if the model drops or mangles a
  sentinel, the code automatically degrades to a split-translate path (translate
  prose segments only, splice formulas back) so formulas are never corrupted.
- translation is **lazy + cached** in D1 (`translations(paper_id, block_id)`):
  cache hits are skipped, misses call the gateway and are written back.

## LLM gateway

This Worker expects an LLM gateway exposing OpenAI-compatible
`/v1/chat/completions` and `/v1/embeddings`. Wire it up either way:

1. **Plain HTTP** — set `LLM_GATEWAY_URL` in `wrangler.toml` to your gateway's
   base URL. `src/llm/gateway.ts` calls it via `fetch`.
2. **Service binding** (same Cloudflare account) — bind your gateway Worker as
   `API_LLM`. When present, calls route through `binding.fetch`; when absent
   (e.g. `wrangler dev` / `npm test`), the code falls back to
   `fetch(LLM_GATEWAY_URL)` automatically.

The default models referenced in config (`qwen-mt-turbo` for translation,
`qwen3.7-plus` for Q&A / mind map, `text-embedding-v4` for embeddings) are just
defaults — point the gateway at whatever models you have and adjust the `[vars]`
in `wrangler.toml`.

## Develop

```bash
npm install
npm test          # unit tests (translation retry, masking, QA, annotations, ...)
npm run typecheck # tsc --noEmit
npx wrangler dev  # local dev (binding absent → falls back to LLM_GATEWAY_URL)
```

Tests are offline and mock the gateway, so they run with no secrets and no
network.

## Deploy

1. Create a D1 database and put its id in `wrangler.toml`:
   ```bash
   wrangler d1 create research      # copy the id into database_id
   wrangler d1 migrations apply research
   ```
2. Set secrets (never commit values):
   ```bash
   wrangler secret put SERVICE_TOKEN_RESEARCH   # bearer token for your LLM gateway
   wrangler secret put USERS_JSON               # e.g. {"alice":"<password>"}
   wrangler secret put SESSION_SECRET           # HMAC key, same value as the frontend
   ```
   ⚠ If `USERS_JSON` / `SESSION_SECRET` are unset, every `/api/*` request returns
   `503` (fail-closed — the API never silently opens).
3. Deploy:
   ```bash
   npx wrangler deploy
   ```

`USERS_JSON` and `SESSION_SECRET` must match the frontend's values so the
session cookie interoperates across the Pages app and this Worker.

## End-to-end translation check

`scripts/e2e-translate.sh` translates a real paper end-to-end (verifies "one
readable paper + formulas intact"). It needs a live gateway token; without one
it **skips** rather than fails:

```bash
RESEARCH_TOKEN=<token> GATEWAY_URL=https://api-llm.example.com \
  bash scripts/e2e-translate.sh 1706.03762v7
```

## License

[MIT](../LICENSE)
