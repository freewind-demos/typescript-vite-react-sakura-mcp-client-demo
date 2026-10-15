// 一个最小可用的 MCP Server：通过 stdio 与客户端通信，对外暴露三个工具。
// 启动方式：node server/demo-mcp-server.mjs
//
// 关键约束：MCP 协议用 stdout 传消息，所以这里只能往 stderr 打日志，
// 一旦往 stdout 写了任何东西，协议帧就会被污染，客户端会解析失败。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 声明 server 身份：客户端 initialize 之后能读到这里的 name 与 version
const server = new McpServer({
  name: "demo-tools",
  version: "1.0.0",
});

// 工具一：原样回显传入的文本，用来验证「参数传递 + 结果返回」这条链路
server.registerTool(
  "echo",
  {
    title: "回显文本",
    description: "把传入的文本原样返回",
    // inputSchema 用 zod 描述参数；SDK 会把它转成 JSON Schema 暴露给客户端
    inputSchema: { text: z.string().describe("要回显的文本") },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

// 工具二：两个数相加，演示多参数与数值类型
server.registerTool(
  "add",
  {
    title: "两数相加",
    description: "计算 a + b 的结果",
    inputSchema: {
      a: z.number().describe("第一个加数"),
      b: z.number().describe("第二个加数"),
    },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

// 工具三：无参数，返回服务端当前时间，演示「零参数工具」
server.registerTool(
  "now",
  {
    title: "当前时间",
    description: "返回服务端当前时间的 ISO 字符串",
  },
  async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }),
);

// 用 stdio 传输启动：此后从 stdin 收请求、往 stdout 回响应
await server.connect(new StdioServerTransport());

// 日志只走 stderr，避免污染协议用的 stdout
console.error("[demo-mcp-server] 已启动，等待客户端通过 stdio 连接");
