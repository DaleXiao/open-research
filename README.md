# open-research

A single-paper reading workbench for arXiv / PDF papers. Read one paper deeply
with side-by-side translation, inline annotations, AI Q&A, and an auto-generated
mind map.

## Features

- **Side-by-side reading** — original + translation (zh/en) aligned by block.
- **Annotations / notes** — select text to attach notes anchored to the source
  block, with bookmark markers and a notes panel that jumps back to the source.
- **Ask AI** — ask questions about a selection or the whole paper (RAG).
- **Mind map** — generate a hierarchical markmap (markmap + d3) of the paper.
- **Client-side parsing** — arXiv LaTeXML HTML and PDF are parsed in the browser;
  the backend only validates and stores the resulting blocks.
- **Import history** — recently imported papers are remembered and restored on
  return.
- Terminal-style UI, strict zh/en i18n parity, light/dark themes.

## Tech stack

- **Frontend:** [Astro](https://astro.build/) (static output) on Cloudflare Pages.
- **Backend:** a separate Cloudflare Worker exposes the `/api/*` contract
  (papers, annotations, mind map, Q&A) backed by D1 + R2. The Worker takes over
  `/api/*` on the same origin, so the frontend fetches relative paths with no
  CORS.
- **Parsing:** `pdfjs-dist` for PDF, `linkedom` / LaTeXML HTML for arXiv.
- **Auth:** cookie-session login (Pages Functions middleware), credentials read
  from environment variables (`USERS_JSON`, `SESSION_SECRET`) — nothing is
  hardcoded.

> This repository contains the **frontend workbench** only. The backend Worker
> (API + parsing orchestration) lives separately and is referenced here only by
> its `/api/*` contract (see `src/lib/api.ts` and `src/lib/qa.ts`).

## Develop

```bash
npm install
npm run dev        # astro dev on http://localhost:4321
npm run build      # astro check && astro build -> dist/
npm run preview    # preview the built site
npm run test:unit  # unit tests (translation retry, arXiv parse parity)
```

End-to-end checks live in `e2e/` (browser automation scripts run with Node).

## Deploy

Static output is built to `dist/` and deployed to Cloudflare Pages:

```bash
npm run build
npx wrangler pages deploy dist --project-name research
```

Configure auth and the backend route via Cloudflare Pages environment variables
and a Worker route for `/api/*`.

## License

[MIT](./LICENSE) © 2026 Tinker Lab
