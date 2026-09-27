import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { LspClient, type Diagnostic, type Location } from "./lsp.ts";

const globalCsharpTool = join(homedir(), ".dotnet", "tools", process.platform === "win32" ? "csharp-ls.exe" : "csharp-ls");

const SERVERS: Record<string, { command: string; language: string }> = {
  ".cs": { command: existsSync(globalCsharpTool) ? globalCsharpTool : "csharp-ls", language: "csharp" },
  ".c": { command: "clangd", language: "c" },
  ".h": { command: "clangd", language: "c" },
  ".cc": { command: "clangd", language: "cpp" },
  ".cpp": { command: "clangd", language: "cpp" },
  ".cxx": { command: "clangd", language: "cpp" },
  ".hpp": { command: "clangd", language: "cpp" },
  ".swift": { command: "sourcekit-lsp", language: "swift" },
};

/** 按行选取代码并附上来源；只填入输入框，不代用户提交消息。 */
export function selectedCode(file: string, lines: string[], from: number, to: number): string {
  const first = Math.min(from, to);
  const last = Math.max(from, to);
  const content = lines.slice(first, last + 1).join("\n");
  const longest = Array.from(content.matchAll(/`+/g)).reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longest + 1);
  return `${file}:${first + 1}-${last + 1}\n${fence}\n${content}\n${fence}`;
}

/** 清理终端控制字符，避免文件名和代码内容改变面板渲染。 */
function safeDisplay(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => char === "\t" ? "  " : "�");
}

/** 验证路径位于当前目录中，阻止索引中的符号链接越出项目。 */
async function projectFile(root: string, file: string): Promise<string> {
  const path = await realpath(file);
  const within = relative(root, path);
  if (within.startsWith(`..${sep}`) || within === ".." || isAbsolute(within)) {
    throw new Error("该文件不在当前项目目录中");
  }
  if ((await stat(path)).size > 1024 * 1024) throw new Error("文件超过 1 MB，暂不在面板中打开");
  return path;
}

/** 将 LSP 结果归一为可选择的文件位置。 */
function locations(value: unknown): Location[] {
  if (!value) return [];
  const results = Array.isArray(value) ? value : [value];
  return results.flatMap((item) => {
    // LocationLink 也可用于定义跳转，选择 origin 的目标范围。
    if (item && typeof item.targetUri === "string" && item.targetSelectionRange) {
      return [{ uri: item.targetUri, range: item.targetSelectionRange }];
    }
    return item && typeof item.uri === "string" && item.range ? [item as Location] : [];
  });
}

/** 获取悬停文本，兼容纯文本、Markdown 和多段内容。 */
function hoverText(value: any): string {
  const contents = value?.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((part) => typeof part === "string" ? part : part.value ?? "").join("\n");
  return typeof contents?.value === "string" ? contents.value : "没有悬停信息";
}

/** 终端内的只读代码浏览器，键盘选区与 LSP 查询均不写文件。 */
export class CodePanel {
  private mode: "files" | "code" | "results" | "detail" = "files";
  private input = new Input();
  private list!: SelectList;
  private file = "";
  private lines: string[] = [];
  private row = 0;
  private column = 0;
  private top = 0;
  private mark?: number;
  private message = "";
  private results: Location[] = [];
  private resultIndex = 0;
  private detail: string[] = [];
  private detailTop = 0;
  private client?: LspClient;
  private busy = false;
  private closed = false;
  private readonly options: SelectItem[];
  private readonly root: string;
  private readonly theme: Theme;
  private readonly refresh: () => void;
  private readonly done: (value: string | undefined) => void;
  focused = true;

  /** 初始化文件搜索列表和终端渲染回调。 */
  constructor(root: string, files: string[], theme: Theme, refresh: () => void, done: (value: string | undefined) => void) {
    this.root = root;
    this.theme = theme;
    this.refresh = refresh;
    this.done = done;
    this.options = files.map((file) => ({ value: file, label: safeDisplay(file) }));
    this.filter("");
  }

  /** 创建文件列表并按输入筛选。 */
  private filter(query: string): void {
    const matches = this.options.filter((item) => item.value.toLowerCase().includes(query.toLowerCase()));
    this.list = new SelectList(matches, 14, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "  没有匹配的文件"),
    });
    this.list.onSelect = (item) => { void this.open(resolve(this.root, item.value)); };
    this.list.onCancel = () => this.finish();
  }

  /** 打开真实磁盘文件，启动对应的本机 LSP；其余语言保持只读浏览。 */
  private async open(file: string, at?: { line: number; character: number }): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const path = await projectFile(this.root, file);
      const text = await readFile(path, "utf8");
      if (text.includes("\0")) throw new Error("暂不支持二进制文件");
      this.client?.stop();
      this.client = undefined;
      this.file = path;
      this.lines = text.split("\n");
      this.row = Math.min(at?.line ?? 0, this.lines.length - 1);
      this.column = at?.character ?? 0;
      this.top = Math.max(0, this.row - 5);
      this.mark = undefined;
      this.mode = "code";
      const server = SERVERS[extname(path).toLowerCase()];
      this.message = server ? `连接 ${server.command}…` : "本文件无已配置的语言服务器，可只读浏览";
      this.refresh();
      if (server) {
        const client = new LspClient(server.command, [], this.root);
        this.client = client;
        client.onDiagnostics = () => { if (!this.closed) this.refresh(); };
        await client.initialize(this.root);
        client.open(path, server.language, text);
        if (server.language === "csharp") {
          this.message = "正在加载 C# 项目…";
          this.refresh();
          await client.waitForProjectLoad();
        }
        this.message = `${server.language === "csharp" ? "C# 项目已加载" : server.command + " 已连接"}`;
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.client?.stop();
      this.client = undefined;
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  /** 查询语言服务器并显示定义、引用、悬停或诊断。 */
  private async inspect(kind: "definition" | "references" | "hover" | "diagnostics"): Promise<void> {
    if (this.busy) return;
    if (!this.client) { this.message = "此文件没有可用的语言服务器"; this.refresh(); return; }
    if (kind !== "diagnostics") {
      const text = this.lines[this.row] ?? "";
      if (!/[\p{L}\p{N}_]/u.test(text[this.column] ?? "") && !/[\p{L}\p{N}_]/u.test(text[this.column - 1] ?? "")) {
        this.message = "请用 ←→ 将光标移到接口名或方法名上再查询";
        this.refresh();
        return;
      }
    }
    if (kind === "diagnostics") {
      const items = this.client.getDiagnostics(this.file);
      this.showLocations(items.map((item) => ({ uri: pathToFileURL(this.file).href, range: item.range })), items.map((item) => item.message.replace(/[\r\n]+/g, " ")));
      return;
    }
    this.busy = true;
    try {
      const value = await this.client.query(`textDocument/${kind}`, this.file, { line: this.row, character: this.column });
      if (kind === "hover") {
        this.detail = hoverText(value).split("\n");
        this.detailTop = 0;
        this.mode = "detail";
      } else {
        this.showLocations(locations(value));
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  /** 显示位置列表，支持选择后打开定义或引用所在文件。 */
  private showLocations(items: Location[], descriptions: string[] = []): void {
    this.results = items;
    this.resultIndex = 0;
    this.detail = descriptions;
    if (items.length === 0) this.message = "没有找到结果";
    else this.mode = "results";
  }

  /** 退出面板前释放语言服务器进程。 */
  private finish(snippet?: string): void {
    this.closed = true;
    this.client?.stop();
    this.done(snippet);
  }

  /** 将代码选区填入对话输入框；未标记时先提示如何选取。 */
  private sendSelection(): void {
    if (this.mark === undefined) { this.message = "先按 v 标记起点，再用方向键选取代码"; return; }
    this.finish(selectedCode(relative(this.root, this.file), this.lines, this.mark, this.row));
  }

  /** 根据当前视图处理键盘输入，不执行任何写文件操作。 */
  handleInput(data: string): void {
    if (this.closed) return;
    if (this.mode === "files") {
      if (matchesKey(data, "escape")) { this.finish(); return; }
      if ((["up", "down", "return"] as const).some((key) => matchesKey(data, key))) this.list.handleInput(data);
      else { this.input.handleInput(data); this.filter(this.input.getValue()); }
    } else if (this.mode === "code") {
      if (matchesKey(data, "escape") || data === "f") { this.mode = "files"; this.mark = undefined; }
      else if (data === "q") { this.finish(); return; }
      else if (matchesKey(data, "up")) this.row = Math.max(0, this.row - 1);
      else if (matchesKey(data, "down")) this.row = Math.min(this.lines.length - 1, this.row + 1);
      else if (matchesKey(data, "left")) this.column = Math.max(0, this.column - 1);
      else if (matchesKey(data, "right")) this.column = Math.min(this.lines[this.row]?.length ?? 0, this.column + 1);
      else if (matchesKey(data, "pageUp")) this.row = Math.max(0, this.row - 12);
      else if (matchesKey(data, "pageDown")) this.row = Math.min(this.lines.length - 1, this.row + 12);
      else if (data === "v") this.mark = this.mark === undefined ? this.row : undefined;
      else if (data === "y") this.sendSelection();
      else if (data === "g") void this.inspect("definition");
      else if (data === "r") void this.inspect("references");
      else if (data === "h") void this.inspect("hover");
      else if (data === "d") void this.inspect("diagnostics");
      this.column = Math.min(this.column, this.lines[this.row]?.length ?? 0);
    } else if (this.mode === "results") {
      if (matchesKey(data, "escape")) this.mode = "code";
      else if (matchesKey(data, "up")) this.resultIndex = Math.max(0, this.resultIndex - 1);
      else if (matchesKey(data, "down")) this.resultIndex = Math.min(this.results.length - 1, this.resultIndex + 1);
      else if (matchesKey(data, "return")) {
        const target = this.results[this.resultIndex];
        if (target) {
          try { void this.open(fileURLToPath(target.uri), target.range.start); }
          catch { this.message = "无法打开语言服务器返回的位置"; }
        }
      }
    } else {
      if (matchesKey(data, "escape")) this.mode = "code";
      else if (matchesKey(data, "up")) this.detailTop = Math.max(0, this.detailTop - 1);
      else if (matchesKey(data, "down")) this.detailTop = Math.min(Math.max(0, this.detail.length - 12), this.detailTop + 1);
    }
    this.refresh();
  }

  /** 渲染有界列表和代码窗口；终端宽度变化时重新布局。 */
  render(width: number): string[] {
    const color = this.theme.fg.bind(this.theme);
    const line = (text: string) => truncateToWidth(safeDisplay(text), Math.max(1, width - 1), "…");
    const title = color("accent", " CODE  /  只读浏览");
    if (this.mode === "files") {
      this.input.focused = this.focused;
      return [title, color("muted", line(` ${this.root} · ${this.options.length} 个文件`)), ...this.input.render(width), ...this.list.render(width), ...(this.message ? [color("warning", line(` ${this.message}`))] : []), color("dim", " 输入筛选  ↑↓ 选择  Enter 打开  Esc 退出")];
    }
    const status = color("muted", line(` ${relative(this.root, this.file)}  ${this.row + 1}:${this.column + 1}`));
    const info = color("accent", line(` ${this.message}`));
    if (this.mode === "results") {
      const start = Math.max(0, Math.min(this.resultIndex - 5, this.results.length - 12));
      const rows = this.results.slice(start, start + 12).map((item, index) => {
        const location = `${fileURLToPath(item.uri)}:${item.range.start.line + 1}`;
        const label = ` ${start + index === this.resultIndex ? "›" : " "} ${location} ${this.detail[start + index] ?? ""}`;
        return start + index === this.resultIndex ? color("accent", line(label)) : line(label);
      });
      return [title, status, info, ...rows, color("dim", " ↑↓ 选择  Enter 跳转  Esc 返回")];
    }
    if (this.mode === "detail") return [title, status, info, ...this.detail.slice(this.detailTop, this.detailTop + 12).map(line), color("dim", " ↑↓ 滚动  Esc 返回")];

    // 代码窗口跟随光标，行号、选区与诊断符号分别标记。
    if (this.row < this.top) this.top = this.row;
    if (this.row >= this.top + 18) this.top = this.row - 17;
    const diagnostics = new Set((this.client?.getDiagnostics(this.file) ?? []).map((item: Diagnostic) => item.range.start.line));
    const rows = this.lines.slice(this.top, this.top + 18).map((text, index) => {
      const number = this.top + index;
      const selected = this.mark !== undefined && number >= Math.min(this.mark, this.row) && number <= Math.max(this.mark, this.row);
      const prefix = `${number === this.row ? "›" : " "}${String(number + 1).padStart(4)}${diagnostics.has(number) ? "!" : " "} `;
      const shown = number === this.row
        ? `${text.slice(0, this.column)}▏${text.slice(this.column)}`
        : text;
      const value = line(prefix + shown);
      return selected ? color("success", value) : number === this.row ? color("accent", value) : value;
    });
    return [title, status, info, ...rows,
      color("dim", " ↑↓←→ 定位  v 选区  y 放入输入框  f 文件  q 退出"),
      color("dim", " g 定义  r 引用  h 悬停  d 诊断  Esc 返回文件")];
  }

  /** 关闭 UI 时兜底清理进程。 */
  dispose(): void { this.client?.stop(); }
  invalidate(): void {}
}

/** 注册 /code 命令，只在交互终端展示代码面板。 */
export default function codeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("code", {
    description: "只读浏览当前目录代码，选区送入对话框并使用本机 LSP 跳转",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/code 仅支持 Pi 交互终端", "error"); return; }
      const root = await realpath(ctx.cwd);
      // 主目录可能包含大量私有容器和上百万文件，不能把它当成项目递归扫描。
      if (root === await realpath(homedir())) {
        ctx.ui.notify("当前目录是主目录，请在项目目录启动 Pi 后再使用 /code", "warning");
        return;
      }
      const args = ["--files", "--hidden", "--no-messages", "-g", "!**/.git/**", "-g", "!**/node_modules/**"];
      const found = await pi.exec("rg", args, { cwd: ctx.cwd });
      if (found.code !== 0 && found.code !== 1 && found.code !== 2) { ctx.ui.notify("无法读取文件列表，请检查当前目录", "error"); return; }
      const files = found.stdout.trimEnd().split("\n").filter(Boolean);
      if (files.length === 0) {
        ctx.ui.notify(found.code === 2 ? "部分目录无法访问，也没有找到可浏览的文件；请进入项目目录后再使用 /code" : "当前目录没有可浏览的文件", "warning");
        return;
      }
      if (found.code === 2) ctx.ui.notify("部分目录无法访问，文件列表不完整；建议在项目目录使用 /code", "warning");
      const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => new CodePanel(root, files, theme, () => tui.requestRender(), done));
      if (selected) {
        const draft = ctx.ui.getEditorText();
        ctx.ui.setEditorText(draft ? `${draft}\n\n${selected}` : selected);
        ctx.ui.notify("已将选中的代码放入输入框，可确认或补充问题后发送", "info");
      }
    },
  });
}
