-- 思维导图 markmap 缓存表。
-- 每篇 paper × 语言一行；可 force 重生成（INSERT OR REPLACE）。
CREATE TABLE IF NOT EXISTS mindmaps (
  paper_id   TEXT NOT NULL,
  lang       TEXT NOT NULL,
  markmap_md TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, lang)
);
