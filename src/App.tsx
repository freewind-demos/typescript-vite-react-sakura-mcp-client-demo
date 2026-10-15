import { useEffect, useState } from "react";
import {
  callTool,
  connectServer,
  fetchServers,
  type CallResult,
  type ConnectResult,
  type McpServerSummary,
  type McpTool,
} from "./api";

// 由 inputSchema 摊平出来的表单字段
type Field = { name: string; type: string; required: boolean };

// 把工具的 inputSchema 转成表单需要的字段列表
function fieldsOf(tool: McpTool | null): Field[] {
  const properties = tool?.inputSchema?.properties ?? {};
  const required = new Set(tool?.inputSchema?.required ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: schema.type ?? "string",
    required: required.has(name),
  }));
}

// 表单里都是字符串，提交前按 schema 声明的类型还原
function buildArguments(fields: Field[], values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? "";
    // 非必填且留空，就不传这个参数
    if (raw === "" && !field.required) continue;
    if (field.type === "number" || field.type === "integer") args[field.name] = Number(raw);
    else if (field.type === "boolean") args[field.name] = raw === "true";
    else args[field.name] = raw;
  }
  return args;
}

// 把 MCP 的返回拼成可读文本
function formatResult(result: CallResult): string {
  const parts = result.content ?? [];
  if (parts.length === 0) return JSON.stringify(result, null, 2);
  return parts.map((part) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part))).join("\n");
}

// 取错误信息
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [serverId, setServerId] = useState("");
  const [connection, setConnection] = useState<ConnectResult | null>(null);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 首次进入：拉取可选的 server 列表
  useEffect(() => {
    void fetchServers()
      .then((list) => {
        setServers(list);
        setServerId((current) => current || list[0]?.id || "");
      })
      .catch((reason: unknown) => setError(messageOf(reason)));
  }, []);

  // serverId 变化即连接：连上后清空上一次的工具选择与结果
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    setBusy(true);
    setError("");
    setResult("");
    setSelectedTool(null);
    void connectServer(serverId)
      .then((data) => {
        if (!cancelled) setConnection(data);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setConnection(null);
        setError(messageOf(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // 选中工具：把表单值重置为该工具字段的空值
  function selectTool(tool: McpTool) {
    setSelectedTool(tool);
    setValues({});
    setResult("");
    setError("");
  }

  // 提交调用
  async function run() {
    if (!selectedTool) return;
    setBusy(true);
    setError("");
    try {
      const fields = fieldsOf(selectedTool);
      const data = await callTool(serverId, selectedTool.name, buildArguments(fields, values));
      setResult(formatResult(data));
    } catch (reason: unknown) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const tools = connection?.tools ?? [];
  const fields = fieldsOf(selectedTool);

  return (
    <main>
      <h1>MCP Client</h1>

      <section>
        <label htmlFor="server">Server</label>
        <select id="server" value={serverId} disabled={busy} onChange={(event) => setServerId(event.target.value)}>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.label}
            </option>
          ))}
        </select>
        <p>
          <small>
            {connection?.serverInfo
              ? `${connection.serverInfo.name} v${connection.serverInfo.version} · ${tools.length} 个工具`
              : busy
                ? "连接中…"
                : "未连接"}
          </small>
        </p>
      </section>

      <section>
        <h2>Tools</h2>
        <ul>
          {tools.map((tool) => (
            <li key={tool.name}>
              <button type="button" disabled={busy} onClick={() => selectTool(tool)}>
                {tool.name}
              </button>{" "}
              <small>{tool.description}</small>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Call</h2>
        {selectedTool ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            {fields.map((field) => (
              <p key={field.name}>
                <label htmlFor={field.name}>
                  {field.name}
                  {field.required ? " *" : ""}
                </label>
                <input
                  id={field.name}
                  value={values[field.name] ?? ""}
                  placeholder={field.type}
                  onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                />
              </p>
            ))}
            <button type="submit" disabled={busy}>
              Call {selectedTool.name}
            </button>
          </form>
        ) : (
          <p>
            <small>先选一个工具</small>
          </p>
        )}
        {error ? <p role="alert">{error}</p> : null}
        {result ? <pre>{result}</pre> : null}
      </section>
    </main>
  );
}
