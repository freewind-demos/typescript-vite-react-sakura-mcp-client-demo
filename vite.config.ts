import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// 带 .ts 扩展名：Vite 的原生配置加载器要求显式扩展名
import { mcpApiPlugin } from "./server/mcp-middleware.ts";

// 全程只有一个端口：MCP 客户端以中间件形式挂在 Vite dev server 上，
// 页面与 /api 同源，不需要单独启动后端、也不需要配代理。
export default defineConfig({
  plugins: [react(), mcpApiPlugin()],
});
