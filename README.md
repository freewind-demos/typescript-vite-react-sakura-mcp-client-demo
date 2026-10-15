# typescript-vite-react-sakura-mcp-client-demo

## 简介

这个 Demo 在浏览器里演示一个 MCP 客户端：手填一个 MCP Server 的连接信息，连上后查看它暴露的工具，真的调用它，并且能看到底层收发的原始 JSON-RPC 报文。

页面只有四块：填连接信息、看工具列表、填参数并调用、看原始报文。样式用 classless 的 sakura.css，页面代码里没有任何类名。

## 快速开始

### 环境要求

- Node.js 20 以上（本项目在 Node 26 上验证）
- pnpm

### 运行

```bash
pnpm install
pnpm run dev
```

浏览器会自动打开。连接信息默认预填本项目自带的 `demo-tools` server，打开即可用；把它改成别的 server 的启动命令就能连别的。

## 注意事项

- `demo-tools` 是本项目自带的 server，离线可用；换成官方的 `filesystem` 时，第一次 `npx` 需要联网下载，会等几秒。
- MCP 的 stdio 传输用 stdout 传协议消息，所以自带的 server 只允许往 stderr 打日志；一旦往 stdout 打印，协议帧就会被污染。
- 浏览器不能直接拉起子进程，所以 MCP 客户端跑在 Node 侧，以 Vite 中间件的形式挂在同一个端口上；页面只发 `/api/*` 请求，不跨端口、不需要代理。
- 连接信息由页面提交，服务端会按它 spawn 子进程。这是本机 Demo，没有做白名单限制。

## 教程

### 1. MCP 是什么

MCP（Model Context Protocol）是一套让客户端和「能力提供方」对话的协议。提供方叫 MCP Server，它对外暴露三类东西：工具（tools，可执行动作）、资源（resources，只读数据）、提示词（prompts，模板）。

客户端连上 server 后，可以用标准方法问它有什么能力，也可以请求执行某个工具。这套协议和具体语言、具体模型无关，所以同一个 server 能被不同的客户端复用。

### 2. 连接一个 MCP Server 要填什么

用 stdio 传输时，客户端要做的其实就是「按给定命令启动一个子进程」，所以连接信息就是一条启动命令的完整描述：

- `command`：可执行文件，必填，如 `npx`、`node`
- `args`：传给它的参数，如 `-y`、`@modelcontextprotocol/server-filesystem`、`/tmp`
- `cwd`：子进程的工作目录，选填，留空用项目根
- `env`：追加给子进程的环境变量，选填，如 `API_KEY=xxx`

换成官方的 filesystem server，就是：

```text
command: npx
args:
  -y
  @modelcontextprotocol/server-filesystem
  /tmp
```

另一类传输是 HTTP/SSE，填的是 `url` 和 `headers`，不需要启动子进程。本项目用的是 stdio，所以只做了上面四个字段。

### 3. 一次会话的协议流程

本 Demo 实际走的就是这三步：

1. `initialize`：客户端与 server 握手，交换各自的名称、版本与能力。页面顶部显示的 `demo-tools v1.0.0` 就来自这一步。
2. `tools/list`：客户端拉取工具清单。页面里的 Tools 列表来自这一步，每条含名称、描述和参数的 JSON Schema。
3. `tools/call`：客户端指定工具名和参数，请求执行。页面里的返回值来自这一步。

这三步都由 `@modelcontextprotocol/sdk` 封装好了，代码里看不到裸的 JSON-RPC 报文。想知道它们长什么样，见下面第 7 节。

### 4. 为什么客户端必须跑在 Node 侧

MCP 支持多种传输方式，本项目用的是 stdio：客户端 spawn 一个子进程，通过它的标准输入输出收发消息。

浏览器的 JS 不能创建子进程，所以浏览器直连 stdio server 是做不到的。本项目的做法是：

- Node 侧（Vite dev server）跑真正的 MCP 客户端，负责 spawn 子进程和收发协议消息。
- 浏览器只和 Node 侧的 `/api/*` 打交道。
- 两边同源、同端口，不需要单独启动后端，也不需要配代理。

### 5. 自带 server：注册工具

见 [server/demo-mcp-server.mjs](server/demo-mcp-server.mjs)。核心是用 `McpServer` 建 server，再用 `registerTool` 注册工具：

```js
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
```

`inputSchema` 用 zod 写，SDK 会自动把它转成 JSON Schema 发给客户端。客户端拿到的就是那份 JSON Schema，所以页面可以据此动态生成表单。

最后用 `StdioServerTransport` 启动，server 就开始在 stdin 上等消息了。

### 6. 客户端中间件：连接与转发

见 [server/mcp-middleware.ts](server/mcp-middleware.ts)。三个接口对应上面三步协议：

- `GET /api/preset`：返回自带 server 的预填连接信息，页面打开时填进表单。
- `POST /api/connect`：按页面提交的 `command/args/cwd/env` spawn 并连接，返回 server 身份、能力、工具清单和原始报文。
- `POST /api/call`：按工具名与参数调用，返回 MCP 的结果和原始报文。

连接的核心两行是创建客户端和传输层：

```ts
const client = new Client({ name: "sakura-mcp-web-client", version: "1.0.0" });
const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd, env });
await client.connect(transport);
```

`connect` 内部会完成 `initialize` 握手。之后 `client.listTools()` 和 `client.callTool(...)` 就是直接可用的方法。

### 7. 怎么拿到原始 JSON-RPC 报文

SDK 把 JSON-RPC 藏在了 `Client` 里面，但它和 server 之间所有消息都要经过 transport 的 `send` 和 `onmessage`。所以只要包住这两个口子，就能把每一条报文都抄一份：

```ts
const originalSend = transport.send.bind(transport);
transport.send = async (message, options) => {
  record("client→server", message);
  await originalSend(message, options);
};

// Client.connect 会给 onmessage 赋值，用存取器截住这次赋值
Object.defineProperty(transport, "onmessage", {
  configurable: true,
  get: () => handler,
  set: (next) => {
    handler = (message, extra) => {
      record("server→client", message);
      next(message, extra);
    };
  },
});
```

`record` 把消息序列化成 JSON 存进内存日志，`/api/connect` 与 `/api/call` 的响应里带上这份日志，页面底部的 Raw JSON-RPC 区就把它整段显示出来。挂钩必须放在 `client.connect(transport)` 之前，因为 connect 里才会给 `onmessage` 赋值。

这样不改协议逻辑，就能看到：

- `initialize` 请求与响应里的协议版本、能力声明
- `tools/list` 返回的完整工具定义（含每个参数的 JSON Schema）
- `tools/call` 的请求参数与原始 `CallToolResult`（`content`、`isError` 等字段都在）

### 8. 前端：按 schema 生成表单

见 [src/App.tsx](src/App.tsx)。选中一个工具后，页面读取它的 `inputSchema.properties`，为每个属性生成一个输入框，`required` 里列出的字段标上星号。

提交时按 schema 声明的类型还原：`number` / `integer` 转成数字，`boolean` 转成布尔，其余按字符串传。这一步不能省——表单里拿到的永远是字符串，直接传给 server 会因为类型不符而校验失败。

样式方面，sakura.css 只按 HTML 标签排版，所以页面里用的是 `section`、`ul`、`form`、`pre` 这些原生标签，没有引入任何组件库。
