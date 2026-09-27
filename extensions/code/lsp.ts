import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface Position { line: number; character: number }
export interface Location { uri: string; range: { start: Position; end: Position } }
export interface Diagnostic { range: { start: Position; end: Position }; message: string; severity?: number }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** 与本机已安装的语言服务器通过 stdio JSON-RPC 通信。 */
export class LspClient {
  private process: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private stderr = "";
  private diagnostics = new Map<string, Diagnostic[]>();
  private projectLoaded = false;
  private projectWaiter?: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  onDiagnostics?: (uri: string, items: Diagnostic[]) => void;

  /** 连接本机语言服务器并监听 JSON-RPC 响应。 */
  constructor(command: string, args: string[] = [], cwd?: string) {
    this.process = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-1024); });
    this.process.on("error", (error) => this.stop(error));
    this.process.on("exit", (code) => this.stop(new Error(`语言服务器已退出（${code ?? "未知状态"}）：${this.stderr.trim()}`)));
  }

  /** 初始化工作区；仅支持已经安装并可从 PATH 调用的服务器。 */
  async initialize(root: string): Promise<void> {
    const rootUri = pathToFileURL(root).href;
    await this.request("initialize", { processId: process.pid, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: root.split("/").at(-1) }] });
    this.notify("initialized", {});
  }

  /** 向语言服务器同步只读缓冲区，供诊断和语义查询使用。 */
  open(file: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text } });
  }

  /** 等待 C# 服务器实际加载项目，而不把 LSP 握手成功误当作引用可用。 */
  waitForProjectLoad(): Promise<void> {
    if (this.projectLoaded) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("语言服务器不可用"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.projectWaiter = undefined;
        reject(new Error("C# 项目未加载，请确认当前目录包含 .sln 或 .csproj"));
      }, 30_000);
      this.projectWaiter = { resolve, reject, timer };
    });
  }

  /** 获取文件上次收到的诊断。 */
  getDiagnostics(file: string): Diagnostic[] {
    return this.diagnostics.get(pathToFileURL(file).href) ?? [];
  }

  /** 查询光标处的定义、引用或悬停。 */
  query(method: "textDocument/definition" | "textDocument/references" | "textDocument/hover", file: string, position: Position): Promise<unknown> {
    return this.request(method, {
      textDocument: { uri: pathToFileURL(file).href }, position,
      ...(method === "textDocument/references" ? { context: { includeDeclaration: true } } : {}),
    });
  }

  /** 停止进程并释放等待中的请求。 */
  stop(reason = new Error("语言服务器已关闭")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    if (this.projectWaiter) {
      clearTimeout(this.projectWaiter.timer);
      this.projectWaiter.reject(reason);
      this.projectWaiter = undefined;
    }
    this.process.kill();
  }

  /** 发送有超时的 JSON-RPC 请求，避免关闭界面后仍悬挂。 */
  private request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("语言服务器不可用"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`语言服务器响应超时：${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** 发送无需响应的通知。 */
  private notify(method: string, params: object): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  /** 按 LSP 的 Content-Length 帧格式写入进程。 */
  private send(value: object): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  /** 从任意分片读取完整帧，处理一次输出包含多条消息的情况。 */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString();
      const length = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1];
      if (!length) { this.stop(new Error("语言服务器返回了无效的消息头")); return; }
      const size = Number(length);
      if (this.buffer.length < end + 4 + size) return;
      const body = this.buffer.subarray(end + 4, end + 4 + size);
      this.buffer = this.buffer.subarray(end + 4 + size);
      try { this.dispatch(JSON.parse(body.toString("utf8"))); }
      catch { this.stop(new Error("语言服务器返回了无效的 JSON")); return; }
    }
  }

  /** 派发响应及诊断消息。 */
  private dispatch(message: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { message: string } }): void {
    // 服务器也会主动发送请求；至少须确认动态能力注册，否则 C# 服务会一直等待客户端。
    if (message.id !== undefined && message.method) {
      if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability" || message.method === "window/workDoneProgress/create") {
        this.send({ jsonrpc: "2.0", id: message.id, result: null });
      } else if (message.method === "workspace/configuration") {
        this.send({ jsonrpc: "2.0", id: message.id, result: (message.params?.items ?? []).map(() => ({})) });
      } else {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `不支持的 LSP 请求：${message.method}` } });
      }
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method === "$/progress" && message.params?.value?.kind === "end" && /project/i.test(message.params.value.message ?? "")) {
      // csharp-ls 初始化后异步加载 .sln/.csproj，只有成功加载后才可查询引用。
      const summary = message.params.value.message as string;
      this.projectLoaded = summary.startsWith("OK");
      if (this.projectWaiter) {
        clearTimeout(this.projectWaiter.timer);
        if (this.projectLoaded) this.projectWaiter.resolve();
        else this.projectWaiter.reject(new Error(`C# 项目加载失败：${summary}`));
        this.projectWaiter = undefined;
      }
    } else if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      const items = message.params?.diagnostics;
      if (typeof uri === "string" && Array.isArray(items)) {
        this.diagnostics.set(uri, items);
        this.onDiagnostics?.(uri, items);
      }
    }
  }
}
