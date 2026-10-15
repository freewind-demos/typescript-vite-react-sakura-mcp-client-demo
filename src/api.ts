// 前端与 /api 之间的薄封装：只负责发请求、统一错误、给出类型

// 可选 MCP Server 的摘要，来自 GET /api/servers
export type McpServerSummary = {
  id: string;
  label: string;
  command: string;
  args: string[];
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
  serverInfo: { name: string; version: string } | null;
  capabilities: Record<string, unknown> | null;
  tools: McpTool[];
};

// 工具调用结果，来自 POST /api/call（MCP 的 CallToolResult）
export type CallResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
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

// 列出可选的 MCP Server
export async function fetchServers(): Promise<McpServerSummary[]> {
  const response = await fetch("/api/servers");
  const data = (await response.json()) as { servers: McpServerSummary[] };
  return data.servers;
}

// 连接指定 server，拿回身份、能力与工具清单
export function connectServer(serverId: string): Promise<ConnectResult> {
  return post<ConnectResult>("/api/connect", { serverId });
}

// 调用某个工具
export function callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return post<CallResult>("/api/call", { serverId, name, arguments: args });
}
