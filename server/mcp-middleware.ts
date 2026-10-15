// MCP 客户端中间件：把「按配置连接 server、查看它的工具、调用工具」三件事
// 以 /api/* 的形式暴露给浏览器页面，并把底层 JSON-RPC 原始报文一并回传。
//
// 为什么必须放在 Node 侧：MCP 的 stdio 传输要 spawn 一个子进程，
// 浏览器做不到，所以由 Vite dev server 代跑客户端，页面只发 HTTP 请求。

import { existsSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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

// 页面要填的连接信息：也就是启动一个 stdio MCP Server 所需的全部字段
export type ServerConfig = {
  // 可执行文件，如 npx、node
  command: string;
  // 传给它的参数，如 ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  args: string[];
  // 子进程工作目录，留空则用项目根
  cwd: string;
  // 追加的环境变量，如 { API_KEY: "..." }
  env: Record<string, string>;
};

// 一条原始 JSON-RPC 报文
export type RawEntry = {
  // 递增序号，便于对照请求与响应
  seq: number;
  // 记录时间（ISO 字符串）
  at: string;
  // 方向：client→server 是客户端发出，server→client 是 server 返回
  direction: "client→server" | "server→client";
  // 报文的完整 JSON 文本
  text: string;
};

// 自带 server 的预填配置：页面打开就有一份能直接连的连接信息
const PRESET: ServerConfig = {
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, "server", "demo-mcp-server.mjs")],
  cwd: PROJECT_ROOT,
  env: {},
};

// 同一时刻只保留一个连接；key 是连接配置的指纹，配置变了就重连
let current: { key: string; client: Client } | undefined;

// 原始报文日志：每次建立新连接时清空
let rawLog: RawEntry[] = [];
let rawSeq = 0;

// 追加一条报文
function record(direction: RawEntry["direction"], message: unknown): void {
  rawSeq += 1;
  rawLog.push({
    seq: rawSeq,
    at: new Date().toISOString(),
    direction,
    text: JSON.stringify(message, null, 2),
  });
}

// 清空报文日志：每一轮请求只保留本轮的报文，不与上一轮累加
function resetRaw(): void {
  rawLog = [];
  rawSeq = 0;
}

// 在 transport 层挂钩。MCP SDK 把 JSON-RPC 的收发封装在 Client 内部，
// 这里包住 transport 的 send 与 onmessage，凡进出的消息都留一份原文。
function tapTransport(transport: Transport): void {
  // 包住 send：客户端发出的每一条请求都会经过这里
  const originalSend = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage, options?: TransportSendOptions) => {
    record("client→server", message);
    await originalSend(message, options);
  };

  // Client.connect 会给 onmessage 赋值，所以用存取器截住这次赋值，
  // 在 SDK 真正的处理函数之前先把收到的报文记下来。
  let handler: Transport["onmessage"];
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => handler,
    set: (next: Transport["onmessage"]) => {
      handler = next
        ? (message, extra) => {
            record("server→client", message);
            next(message, extra);
          }
        : undefined;
    },
  });
}

// 按配置取客户端；配置没变就复用，变了就关掉旧的、重建
async function getClient(config: ServerConfig): Promise<Client> {
  const key = JSON.stringify(config);
  if (current?.key === key) return current.client;
  if (current) {
    await current.client.close().catch(() => {});
    current = undefined;
  }

  // 换一份配置就是一轮新会话，报文日志从头开始
  resetRaw();

  // Client 是 MCP 客户端本体，connect 时会自动完成 initialize 握手
  const client = new Client({ name: "sakura-mcp-web-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // 用户填的环境变量叠在默认环境之上
    env: { ...getDefaultEnvironment(), ...config.env },
    // 没填工作目录就用项目根
    cwd: config.cwd || PROJECT_ROOT,
    // 子进程的日志直接打到 Vite 终端，方便排查
    stderr: "inherit",
  });
  // 挂上报文记录，必须在 connect 之前
  tapTransport(transport);
  await client.connect(transport);

  current = { key, client };
  return client;
}

// 校验页面提交的连接信息，缺 command 直接报错
function toConfig(input: Record<string, unknown>): ServerConfig {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("command 不能为空");

  const args = Array.isArray(input.args) ? input.args.map((item) => String(item)) : [];

  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";

  const env: Record<string, string> = {};
  if (input.env && typeof input.env === "object") {
    for (const [name, value] of Object.entries(input.env as Record<string, unknown>)) {
      env[name] = String(value);
    }
  }

  return { command, args, cwd, env };
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
      // 挂载点是 /api，Connect 会把该前缀剥掉，所以下面按 /preset 这类路径判断
      server.middlewares.use("/api", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          // 1) 返回自带 server 的预填配置，页面打开时用它填表
          if (req.method === "GET" && url.pathname === "/preset") {
            sendJson(res, 200, { config: PRESET });
            return;
          }

          // 2) 按页面填的信息连接，返回身份、能力、工具清单，以及这一轮的全部报文
          if (req.method === "POST" && url.pathname === "/connect") {
            const body = await readJsonBody(req);
            const config = toConfig(body);
            // 这一轮只保留连接过程中的报文
            resetRaw();
            const client = await getClient(config);
            const { tools } = await client.listTools();
            sendJson(res, 200, {
              config,
              serverInfo: client.getServerVersion() ?? null,
              capabilities: client.getServerCapabilities() ?? null,
              tools,
              raw: rawLog,
            });
            return;
          }

          // 3) 调用某个工具，把 MCP 的返回原样交给页面，并附上最新的报文
          if (req.method === "POST" && url.pathname === "/call") {
            const body = await readJsonBody(req);
            if (!current) throw new Error("尚未连接，请先连接 MCP Server");
            // 这一轮只保留本次调用的报文
            resetRaw();
            const result = await current.client.callTool({
              name: String(body.name),
              arguments: (body.arguments ?? {}) as Record<string, unknown>,
            });
            sendJson(res, 200, { result, raw: rawLog });
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
