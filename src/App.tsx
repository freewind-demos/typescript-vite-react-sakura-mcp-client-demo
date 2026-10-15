import { useEffect, useState } from "react";
import {
  callTool,
  connectServer,
  fetchPreset,
  type CallResult,
  type ConnectResult,
  type McpServerConfig,
  type McpTool,
  type RawEntry,
} from "./api";

// 连接表单的原始输入：全是字符串，提交前再拆成结构化配置
type FormState = { command: string; args: string; cwd: string; env: string };

// 由 inputSchema 摊平出来的表单字段
type Field = {
  name: string;
  // 参数类型：string / number / integer / boolean / array / object
  type: string;
  required: boolean;
  // 数组元素的类型，用来生成输入示例
  itemType?: string;
  // 参数说明，来自 schema 的 description
  description?: string;
};

// 数组与对象没办法用一个普通输入框表达，改用 JSON 文本输入
function isJsonField(field: Field): boolean {
  return field.type === "array" || field.type === "object";
}

// 给 JSON 输入框一个看得懂的示例
function jsonPlaceholder(field: Field): string {
  if (field.type === "object") return '{ "key": "value" }';
  if (field.itemType === "number" || field.itemType === "integer") return "[1, 2]";
  if (field.itemType === "object") return '[{ "key": "value" }]';
  return '["字符串"]';
}

// 把工具的 inputSchema 转成表单需要的字段列表
function fieldsOf(tool: McpTool | null): Field[] {
  const properties = tool?.inputSchema?.properties ?? {};
  const required = new Set(tool?.inputSchema?.required ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: schema.type ?? "string",
    required: required.has(name),
    itemType: schema.items?.type,
    description: schema.description,
  }));
}

// 表单里都是字符串，提交前按 schema 声明的类型还原
function buildArguments(fields: Field[], values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? "";
    // 非必填且留空，就不传这个参数
    if (raw === "" && !field.required) continue;
    if (isJsonField(field)) {
      // 数组与对象按 JSON 解析；填错时把字段名带上，便于定位
      try {
        args[field.name] = JSON.parse(raw);
      } catch {
        throw new Error(`${field.name} 不是合法的 JSON，数组应写成 ["a", "b"]`);
      }
      continue;
    }
    if (field.type === "number" || field.type === "integer") args[field.name] = Number(raw);
    else if (field.type === "boolean") args[field.name] = raw === "true";
    else args[field.name] = raw;
  }
  return args;
}

// args 输入框里每行一个参数
function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// env 输入框里每行一个 KEY=VALUE
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    // 没有等号或等号在开头，都不是合法的环境变量行
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

// 表单 → 接口要的连接信息
function configOf(form: FormState): McpServerConfig {
  return {
    command: form.command.trim(),
    args: parseArgs(form.args),
    cwd: form.cwd.trim(),
    env: parseEnv(form.env),
  };
}

// 预填配置 → 表单：args 与 env 各自摊成一行一个
function formOf(config: McpServerConfig): FormState {
  return {
    command: config.command,
    args: config.args.join("\n"),
    cwd: config.cwd,
    env: Object.entries(config.env)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  };
}

// 把 MCP 的返回拼成可读文本
function formatResult(result: CallResult["result"]): string {
  const parts = result.content ?? [];
  if (parts.length === 0) return JSON.stringify(result, null, 2);
  return parts.map((part) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part))).join("\n");
}

// 把一批原始报文拼成可读文本
function rawText(entries: RawEntry[]): string {
  return entries.map((entry) => `${entry.seq} · ${entry.direction} · ${entry.at}\n${entry.text}`).join("\n\n");
}

// 取错误信息
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const [form, setForm] = useState<FormState>({ command: "", args: "", cwd: "", env: "" });
  const [connection, setConnection] = useState<ConnectResult | null>(null);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState("");
  // 本次调用的原始报文：每次调用整段替换，不与上一次累加
  const [callRaw, setCallRaw] = useState<RawEntry[]>([]);
  // 两处 Raw 面板的展开状态
  const [showToolsRaw, setShowToolsRaw] = useState(false);
  const [showCallRaw, setShowCallRaw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 连接：换配置就重连，连上后清空上一次的工具选择、结果与报文
  async function connect(config: McpServerConfig) {
    setBusy(true);
    setError("");
    setResult("");
    setSelectedTool(null);
    setCallRaw([]);
    setShowToolsRaw(false);
    setShowCallRaw(false);
    try {
      const data = await connectServer(config);
      setConnection(data);
    } catch (reason: unknown) {
      setConnection(null);
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  // 首次进入：取回自带 server 的预填配置，填进表单并直接连一次
  useEffect(() => {
    void fetchPreset()
      .then((preset) => {
        setForm(formOf(preset));
        return connect(preset);
      })
      .catch((reason: unknown) => setError(messageOf(reason)));
  }, []);

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
      const data = await callTool(selectedTool.name, buildArguments(fields, values));
      setResult(formatResult(data.result));
      // 只保留这一次调用的报文
      setCallRaw(data.raw);
      setShowCallRaw(false);
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
        <h2>Connection</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect(configOf(form));
          }}
        >
          <p>
            <label htmlFor="command">command *</label>
            <input
              id="command"
              value={form.command}
              placeholder="npx"
              onChange={(event) => setForm((previous) => ({ ...previous, command: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="args">args（每行一个）</label>
            <textarea
              id="args"
              rows={3}
              value={form.args}
              onChange={(event) => setForm((previous) => ({ ...previous, args: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="cwd">cwd</label>
            <input
              id="cwd"
              value={form.cwd}
              onChange={(event) => setForm((previous) => ({ ...previous, cwd: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="env">env（每行 KEY=VALUE）</label>
            <textarea
              id="env"
              rows={2}
              value={form.env}
              onChange={(event) => setForm((previous) => ({ ...previous, env: event.target.value }))}
            />
          </p>
          <button type="submit" disabled={busy}>
            Connect
          </button>
        </form>
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
        {connection ? (
          <>
            <button type="button" disabled={busy} onClick={() => setShowToolsRaw((previous) => !previous)}>
              Raw
            </button>
            {showToolsRaw ? <pre>{rawText(connection.raw)}</pre> : null}
          </>
        ) : null}
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
                {isJsonField(field) ? (
                  <textarea
                    id={field.name}
                    rows={3}
                    value={values[field.name] ?? ""}
                    placeholder={jsonPlaceholder(field)}
                    onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                  />
                ) : (
                  <input
                    id={field.name}
                    value={values[field.name] ?? ""}
                    placeholder={field.type}
                    onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                  />
                )}
                <small>
                  {field.type}
                  {field.itemType ? ` of ${field.itemType}` : ""}
                  {field.description ? ` · ${field.description}` : ""}
                </small>
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
        {callRaw.length > 0 ? (
          <>
            <button type="button" disabled={busy} onClick={() => setShowCallRaw((previous) => !previous)}>
              Raw
            </button>
            {showCallRaw ? <pre>{rawText(callRaw)}</pre> : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
