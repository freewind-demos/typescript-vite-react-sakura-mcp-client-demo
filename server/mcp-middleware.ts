// MCP 客户端中间件：把「指定 server、查看它的工具、调用工具」三件事
// 以 /api/* 的形式暴露给浏览器页面。
//
// 为什么必须放在 Node 侧：MCP 的 stdio 传输要 spawn 一个子进程，
// 浏览器做不到，所以由 Vite dev server 代跑客户端，页面只发 HTTP 请求。

import { existsSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 从起始目录逐级向上查找含 package.json 的目录，作为项目根
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    // 走到文件系统根还没找到，说明不在项目里
    if (parent === dir) throw new Error(`找不到项目根（从 ${startDir} 向上查找）`);
    dir = parent;
  }
}

const PROJECT_ROOT = findProjectRoot(import.meta.dirname);

// 可选的 MCP Server 清单：每一项本质就是一条「启动命令」。
// 想指定别的 server，只需要在这里加一项（command + args 换成对应的启动方式）。
export const MCP_SERVERS = [
  {
    id: "demo-tools",
    label: "demo-tools（本项目自带）",
    // 用当前 Node 可执行文件，避免依赖 PATH 里的 node
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, "server", "demo-mcp-server.mjs")],
  },
  {
    id: "filesystem",
    label: "filesystem（官方示例，首次运行需联网下载）",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", PROJECT_ROOT],
  },
];

// 同一时刻只保留一个连接：切换 server 时关掉旧的
let current: { serverId: string; client: Client } | undefined;

// 按 serverId 取客户端；已连同一个就复用，否则重建连接
async function getClient(serverId: string): Promise<Client> {
  if (current?.serverId === serverId) return current.client;
  if (current) {
    await current.client.close().catch(() => {});
    current = undefined;
  }

  const definition = MCP_SERVERS.find((item) => item.id === serverId);
  if (!definition) throw new Error(`未知的 MCP Server: ${serverId}`);

  // Client 是 MCP 客户端本体，connect 时会自动完成 initialize 握手
  const client = new Client({ name: "sakura-mcp-web-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: definition.command,
    args: definition.args,
    // 子进程的日志直接打到 Vite 终端，方便排查
    stderr: "inherit",
    cwd: PROJECT_ROOT,
  });
  await client.connect(transport);

  current = { serverId, client };
  return client;
}

// 读取并解析 JSON 请求体
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

// 统一以 JSON 返回
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

// Vite 插件：把 /api 挂到 dev server 的中间件链上
export function mcpApiPlugin(): Plugin {
  return {
    name: "mcp-api",
    configureServer(server) {
      // 挂载点是 /api，Connect 会把该前缀剥掉，所以下面按 /servers 这类路径判断
      server.middlewares.use("/api", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          // 1) 列出可选的 server，供页面下拉选择
          if (req.method === "GET" && url.pathname === "/servers") {
            sendJson(res, 200, {
              servers: MCP_SERVERS.map(({ id, label, command, args }) => ({ id, label, command, args })),
            });
            return;
          }

          // 2) 连接指定 server，返回它的身份、能力与工具清单
          if (req.method === "POST" && url.pathname === "/connect") {
            const body = await readJsonBody(req);
            const client = await getClient(String(body.serverId));
            const { tools } = await client.listTools();
            sendJson(res, 200, {
              serverInfo: client.getServerVersion() ?? null,
              capabilities: client.getServerCapabilities() ?? null,
              tools,
            });
            return;
          }

          // 3) 调用某个工具，把 MCP 的返回原样交给页面
          if (req.method === "POST" && url.pathname === "/call") {
            const body = await readJsonBody(req);
            const client = await getClient(String(body.serverId));
            const result = await client.callTool({
              name: String(body.name),
              arguments: (body.arguments ?? {}) as Record<string, unknown>,
            });
            sendJson(res, 200, result);
            return;
          }

          sendJson(res, 404, { error: `未知接口: ${req.method} ${url.pathname}` });
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
