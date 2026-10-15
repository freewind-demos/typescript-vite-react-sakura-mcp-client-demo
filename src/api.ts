// 前端与 /api 之间的薄封装：只负责发请求、统一错误、给出类型

// 连接一个 stdio MCP Server 所需的全部字段，来自页面表单
export type McpServerConfig = {
  // 可执行文件，如 npx、node
  command: string;
  // 传给它的参数
  args: string[];
  // 子进程工作目录，空串表示用服务端默认值
  cwd: string;
  // 追加的环境变量
  env: Record<string, string>;
};

// 一条原始 JSON-RPC 报文，来自 /api/connect 与 /api/call 的 raw 字段
export type RawEntry = {
  seq: number;
  at: string;
  direction: "client→server" | "server→client";
  text: string;
};

// JSON Schema 里我们会用到的部分：属性表与必填项
export type ToolInputSchema = {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
};

// MCP 工具描述，来自 tools/list
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: ToolInputSchema;
};

// 连接结果，来自 POST /api/connect
export type ConnectResult = {
  config: McpServerConfig;
  serverInfo: { name: string; version: string } | null;
  capabilities: Record<string, unknown> | null;
  tools: McpTool[];
  raw: RawEntry[];
};

// 工具调用结果，来自 POST /api/call（MCP 的 CallToolResult 原样返回）
export type CallResult = {
  result: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  raw: RawEntry[];
};

// 统一的 POST 封装：非 2xx 时把服务端 error 抛出来
async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `请求失败: ${response.status}`);
  return data;
}

// 取回自带 server 的预填连接信息
export async function fetchPreset(): Promise<McpServerConfig> {
  const response = await fetch("/api/preset");
  const data = (await response.json()) as { config: McpServerConfig };
  return data.config;
}

// 按连接信息连上 server，拿回身份、能力、工具清单与原始报文
export function connectServer(config: McpServerConfig): Promise<ConnectResult> {
  return post<ConnectResult>("/api/connect", config);
}

// 调用某个工具
export function callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
  return post<CallResult>("/api/call", { name, arguments: args });
}
