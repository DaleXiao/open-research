-- research.example.com — D1 schema
-- M1 解析产物落地 + M2 翻译缓存。M3/M4 表预建占位（本期 M2 只用 papers/translations）。

-- 论文元数据。解析后的 blocks json 存 R2（blocks_r2_key），D1 只存元信息。
CREATE TABLE IF NOT EXISTS papers (
  id           TEXT PRIMARY KEY,         -- arxiv_id（含版本，如 1706.03762v7）或 hash
  source_url   TEXT NOT NULL,
  source_type  TEXT NOT NULL DEFAULT 'arxiv',
  title        TEXT,
  arxiv_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'parsed', -- parsed|error
  block_count  INTEGER NOT NULL DEFAULT 0,
  blocks_r2_key TEXT,                     -- R2 中 blocks json 的 key
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 翻译缓存：per (paper_id, block_id)。懒翻 —— 命中直接返回，未命中调 qwen-mt 后写入。
CREATE TABLE IF NOT EXISTS translations (
  paper_id   TEXT NOT NULL,
  block_id   TEXT NOT NULL,
  text_zh    TEXT NOT NULL,
  model      TEXT NOT NULL,
  degraded   INTEGER NOT NULL DEFAULT 0, -- 1=走了分段降级
  created_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, block_id)
);

-- M3 批注（本期占位，M2 不写）
CREATE TABLE IF NOT EXISTS annotations (
  id             TEXT PRIMARY KEY,
  paper_id       TEXT NOT NULL,
  block_id       TEXT NOT NULL,
  sel_start      INTEGER,
  sel_end        INTEGER,
  quote_snapshot TEXT,
  note_md        TEXT,
  created_at     INTEGER NOT NULL
);

-- M4 提问历史（本期占位）
CREATE TABLE IF NOT EXISTS qa_history (
  id              TEXT PRIMARY KEY,
  paper_id        TEXT NOT NULL,
  scope           TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT,
  cited_block_ids TEXT,
  created_at      INTEGER NOT NULL
);

-- M4 embeddings（本期占位）
CREATE TABLE IF NOT EXISTS embeddings (
  paper_id   TEXT NOT NULL,
  block_id   TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, block_id)
);

CREATE INDEX IF NOT EXISTS idx_translations_paper ON translations(paper_id);
CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id, block_id);
CREATE INDEX IF NOT EXISTS idx_qa_paper ON qa_history(paper_id);
