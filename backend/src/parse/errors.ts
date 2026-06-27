// 解析错误类型（共享给 arxiv / pdf 解析分支，避免 index ↔ pdf 循环依赖）。

export class ParseError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}
