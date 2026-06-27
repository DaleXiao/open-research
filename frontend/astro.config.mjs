import { defineConfig } from "astro/config";

// research.example.com 前端工作台（CF Pages，静态输出）。
// 后端 API 由 research-worker 同源接管 research.example.com/api/*，前端 fetch 相对路径，无 CORS。
export default defineConfig({
  output: "static",
  site: "https://research.example.com",
  build: { format: "directory" },
  server: { port: 4321 },
});
