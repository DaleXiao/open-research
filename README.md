# open-research

A single-paper reading workbench for arXiv / PDF papers. Read one paper deeply
with side-by-side translation, inline annotations, AI Q&A, and an auto-generated
mind map.

This is a monorepo with two deployable pieces:

| Directory    | What it is                          | Runs on                |
| ------------ | ----------------------------------- | ---------------------- |
| `frontend/`  | Astro reading workbench (static)    | Cloudflare Pages       |
| `backend/`   | `/api/*` Worker (D1-backed)         | Cloudflare Workers + D1 |

> **You bring your own LLM gateway.** Translation, embeddings, Q&A and mind-map
> generation are proxied through an external, OpenAI-compatible LLM gateway that
> is **not** included in this repository. Point the backend at any gateway that
> exposes `/v1/chat/completions` and `/v1/embeddings` (see
> [`backend/README.md`](./backend/README.md)).

## Features

- **Side-by-side reading** — original + translation (zh/en) aligned by block.
- **Annotations / notes** — select text to attach notes anchored to the source
  block, with bookmark markers and a notes panel that jumps back to the source.
- **Ask AI** — ask questions about a selection or the whole paper (RAG over the
  paper's blocks).
- **Mind map** — generate a hierarchical markmap (markmap + d3) of the paper.
- **Client-side parsing** — arXiv LaTeXML HTML and PDF are parsed in the browser;
  the backend only validates and stores the resulting blocks.
- **Import history** — recently imported papers are remembered and restored on
  return.
- Terminal-style UI, strict zh/en i18n parity, light/dark themes.

## Architecture

```
                ┌─────────────────────────────┐
   browser ───► │ frontend/  (Astro, CF Pages) │
                │  parses arXiv/PDF → blocks   │
                └──────────────┬──────────────┘
                               │ fetch /api/*  (same origin, no CORS)
                ┌──────────────▼──────────────┐
                │ backend/  (CF Worker + D1)   │
                │  validate · store · translate│
                │  · annotate · Q&A · mind map │
                └──────────────┬──────────────┘
                               │ OpenAI-compatible calls
                ┌──────────────▼──────────────┐
                │  LLM gateway  (NOT in repo,  │
                │  bring your own)             │
                └─────────────────────────────┘
```

The frontend takes over the origin and the backend Worker takes over `/api/*` on
the **same origin**, so the browser calls relative `/api/...` paths with no CORS.
Parsing runs in the browser; the Worker does zero parsing and zero outbound
fetches to arXiv — it validates submitted blocks and persists them in D1.

## Directory structure

```
.
├── frontend/        # Astro static site (Cloudflare Pages)
│   ├── src/         # pages, components, i18n, client parsing, api client
│   ├── functions/   # Pages Functions middleware (cookie-session auth)
│   ├── e2e/         # browser end-to-end scripts
│   ├── test/        # unit tests
│   └── wrangler.toml
├── backend/         # Cloudflare Worker (/api/*) backed by D1
│   ├── src/         # routes, parse types, translate, qa, mindmap, store
│   ├── migrations/  # D1 schema migrations
│   ├── scripts/     # e2e + dev helpers
│   ├── test/        # offline unit tests (gateway mocked)
│   └── wrangler.toml
├── LICENSE
└── README.md
```

## Develop

Each package is independent — install and run them separately.

```bash
# frontend
cd frontend
npm install
npm run dev          # astro dev on http://localhost:4321

# backend (in another terminal)
cd backend
npm install
npm test             # offline unit tests (no secrets, no network)
npx wrangler dev     # local Worker; LLM gateway falls back to LLM_GATEWAY_URL
```

## Deploy

Both pieces deploy to Cloudflare. Deploy the backend first (it owns `/api/*`),
then the frontend.

### Backend (Worker + D1)

```bash
cd backend
wrangler d1 create research                     # put the id into wrangler.toml database_id
wrangler d1 migrations apply research
wrangler secret put SERVICE_TOKEN_RESEARCH      # bearer token for your LLM gateway
wrangler secret put USERS_JSON                  # e.g. {"alice":"<password>"}
wrangler secret put SESSION_SECRET              # HMAC key for session cookies
npx wrangler deploy
```

### Frontend (Pages)

```bash
cd frontend
npm run build
npx wrangler pages deploy dist --project-name research
```

Set the frontend's auth env (`USERS_JSON`, `SESSION_SECRET`) via Cloudflare Pages
environment variables, using the **same values** as the backend so the session
cookie interoperates across both. Configure a Worker route for `/api/*` on the
frontend's domain so the same origin is shared.

## Configuration

Set in `wrangler.toml` / Pages env (see each package's README for details):

| Name                     | Where            | Purpose                                            |
| ------------------------ | ---------------- | -------------------------------------------------- |
| `database_id`            | backend toml     | your D1 database id (`<your-d1-database-id>`)       |
| `LLM_GATEWAY_URL`        | backend toml     | base URL of your OpenAI-compatible LLM gateway     |
| `QWEN_MT_MODEL` / `QA_MODEL` / `EMBED_MODEL` | backend toml | model names your gateway serves    |
| `SERVICE_TOKEN_RESEARCH` | backend secret   | bearer token the Worker presents to the gateway    |
| `USERS_JSON`             | both secret/env  | login accounts, e.g. `{"alice":"<password>"}`       |
| `SESSION_SECRET`         | both secret/env  | HMAC signing key for session cookies (shared)      |

⚠ If `USERS_JSON` / `SESSION_SECRET` are unset, the backend returns `503` for
every `/api/*` request (fail-closed — the API never silently opens).

## License

[MIT](./LICENSE) © 2026 Tinker Lab
