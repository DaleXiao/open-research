-- M2 hotfix: blocks json 改存 D1（取消 R2 依赖，CF 账号未启用 R2）。
-- papers 表加 blocks_json 列；blocks_r2_key 列保留只是为兼容 0001 schema，新代码不再读写。

ALTER TABLE papers ADD COLUMN blocks_json TEXT;
