import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";

type FileEntry = { path: string; untracked: boolean };
type DiffRow = { text: string; kind: "added" | "removed" | "hunk" | "context" | "meta"; oldLine?: number; newLine?: number };
type Comment = { path: string; row: DiffRow; text: string };

/** 清除差异与文件名中的终端控制字符，防止内容影响界面。 */
function safeDisplay(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => char === "\t" ? "  " : "�");
}

/** 解析统一差异的旧/新行号，供逐行评论准确定位。 */
export function parsePatch(patch: string): DiffRow[] {
  if (!patch) return [{ text: "（空文件或没有可显示的文本差异）", kind: "meta" }];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return patch.replace(/\n$/, "").split("\n").map((text) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      return { text, kind: "hunk", newLine };
    }
    if (!inHunk) return { text, kind: "meta" };
    if (text.startsWith("+") && !text.startsWith("+++")) return { text, kind: "added", newLine: newLine++ };
    if (text.startsWith("-") && !text.startsWith("---")) return { text, kind: "removed", oldLine: oldLine++ };
    if (text.startsWith(" ")) return { text, kind: "context", oldLine: oldLine++, newLine: newLine++ };
    return { text, kind: "meta" };
  });
}

/** 将多条定位评论放入草稿，明确差异不一定由 AI 产生。 */
function commentDraft(comments: Comment[]): string {
  return ["请审阅当前仓库未提交的改动，并逐条处理以下评论（改动可能包含我手动修改的内容）：", ...comments.map(({ path, row, text }, index) => {
    const location = row.newLine ? `${path}:${row.newLine}` : row.oldLine ? `${path}:${row.oldLine}（旧行）` : path;
    return `${index + 1}. ${safeDisplay(location)}\n   差异：${safeDisplay(row.text)}\n   评论：${text}`;
  })].join("\n\n");
}

/** 在终端浏览工作区差异、批注并统一送入 Pi 草稿的只读组件。 */
export class DiffPanel {
  private mode: "files" | "diff" | "comment" = "files";
  private input = new Input();
  private commentInput = new Input();
  private list!: SelectList;
  private readonly options: SelectItem[];
  private readonly entries: FileEntry[];
  private readonly theme: Theme;
  private readonly load: (entry: FileEntry) => Promise<string>;
  private readonly refresh: () => void;
  private readonly done: (value?: string) => void;
  private entry?: FileEntry;
  private rows: DiffRow[] = [];
  private index = 0;
  private top = 0;
  private comments: Comment[] = [];
  private message = "";
  private busy = false;
  focused = true;

  /** 初始化筛选列表与差异读取回调。 */
  constructor(entries: FileEntry[], theme: Theme, load: (entry: FileEntry) => Promise<string>, refresh: () => void, done: (value?: string) => void) {
    this.entries = entries;
    this.theme = theme;
    this.load = load;
    this.refresh = refresh;
    this.done = done;
    this.options = entries.map((entry, index) => ({ value: String(index), label: `${entry.untracked ? "?" : "Δ"}  ${safeDisplay(entry.path)}` }));
    this.filter("");
  }

  /** 按文件名筛选差异文件。 */
  private filter(query: string): void {
    this.list = new SelectList(this.options.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())), 14, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "  没有匹配的文件"),
    });
    this.list.onSelect = (item) => { void this.open(this.entries[Number(item.value)]!); };
    this.list.onCancel = () => this.leave();
  }

  /** 读取选中的单个文件差异，避免预先装载整个仓库。 */
  private async open(entry: FileEntry): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const patch = await this.load(entry);
      this.entry = entry;
      this.rows = parsePatch(patch);
      this.index = 0;
      this.top = 0;
      this.mode = "diff";
      this.message = "";
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally { this.busy = false; this.refresh(); }
  }

  /** 保存当前差异行的单条评论，空内容不加入列表。 */
  private saveComment(): void {
    const text = this.commentInput.getValue().trim();
    if (text && this.entry) this.comments.push({ path: this.entry.path, row: this.rows[this.index]!, text });
    this.commentInput = new Input();
    this.mode = "diff";
    this.message = text ? `已保存 ${this.comments.length} 条评论；按 S 放入输入框` : "空评论未保存";
  }

  /** 将已保存的评论作为草稿交还命令处理器，不自行发送消息。 */
  private sendComments(): void {
    if (!this.comments.length) { this.message = "请先在差异行按 c 添加评论"; return; }
    this.done(commentDraft(this.comments));
  }

  /** 有未发送评论时保留面板，防止误按 Esc 丢失；q 可明确放弃。 */
  private leave(): void {
    if (this.comments.length) this.message = `还有 ${this.comments.length} 条评论：按 S 放入输入框，或按 q 放弃`;
    else this.done();
  }

  /** 处理文件筛选、差异导航和评论输入。 */
  handleInput(data: string): void {
    if (this.mode === "comment") {
      if (matchesKey(data, "escape")) { this.commentInput = new Input(); this.mode = "diff"; }
      else if (matchesKey(data, "return")) this.saveComment();
      else this.commentInput.handleInput(data);
    } else if (this.mode === "files") {
      if (data === "S") this.sendComments();
      else if (data === "q" && this.input.getValue() === "") this.done();
      else if (matchesKey(data, "escape")) this.leave();
      else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "return")) this.list.handleInput(data);
      else { this.input.handleInput(data); this.filter(this.input.getValue()); }
    } else {
      if (data === "S") this.sendComments();
      else if (data === "q") this.done();
      else if (matchesKey(data, "escape")) this.mode = "files";
      else if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, "down")) this.index = Math.min(this.rows.length - 1, this.index + 1);
      else if (matchesKey(data, "pageUp")) this.index = Math.max(0, this.index - 18);
      else if (matchesKey(data, "pageDown")) this.index = Math.min(this.rows.length - 1, this.index + 18);
      else if (data === "c") { this.commentInput = new Input(); this.mode = "comment"; }
    }
    this.refresh();
  }

  /** 用语义颜色呈现增删行、位置及评论编辑框。 */
  render(width: number): string[] {
    const fit = (text: string) => truncateToWidth(safeDisplay(text), Math.max(1, width - 1), "…");
    const fg = this.theme.fg.bind(this.theme);
    const heading = fg("accent", fit(" DIFF  /  工作区审阅"));
    const note = fg("muted", fit(` HEAD → 当前工作区 · ${this.entries.length} 个文件 · ${this.comments.length} 条评论 · 可能包含手动改动`));
    if (this.mode === "files") {
      this.input.focused = this.focused;
      return [heading, note, ...this.input.render(width), ...this.list.render(width), ...(this.message ? [fg("warning", fit(` ${this.message}`))] : []), fg("dim", fit(" 输入筛选  ↑↓ 选择  Enter 打开  S 送出评论  Esc 退出"))];
    }
    const file = fg("accent", fit(` ${this.entry?.path ?? ""}`));
    if (this.mode === "comment") {
      this.commentInput.focused = this.focused;
      const row = this.rows[this.index];
      const location = row?.newLine ?? row?.oldLine ?? "文件";
      return [heading, file, fg("muted", fit(` 评论位置：${location} · ${row?.text ?? ""}`)), ...this.commentInput.render(width), fg("dim", fit(" Enter 保存评论  Esc 取消"))];
    }
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + 18) this.top = this.index - 17;
    const rows = this.rows.slice(this.top, this.top + 18).map((row, offset) => {
      const current = this.top + offset === this.index;
      const position = row.kind === "added" ? `+${row.newLine}` : row.kind === "removed" ? `-${row.oldLine}` : row.newLine ? String(row.newLine) : "";
      const text = fit(` ${current ? "›" : " "} ${position.padStart(5)}  ${row.text}`);
      const color = row.kind === "added" ? "toolDiffAdded" : row.kind === "removed" ? "toolDiffRemoved" : row.kind === "hunk" ? "accent" : row.kind === "meta" ? "muted" : "text";
      const styled = fg(color, text);
      return current ? this.theme.bg("selectedBg", styled) : styled;
    });
    return [heading, file, note, ...rows, ...(this.message ? [fg("warning", fit(` ${this.message}`))] : []), fg("dim", fit(" ↑↓ 翻行  PgUp/PgDn 翻页  c 评论  S 放入输入框  Esc 文件  q 退出"))];
  }

  invalidate(): void {}
}

/** 注册只读 /diff，比较 HEAD 与工作区并将评论写入现有草稿。 */
export default function diffExtension(pi: ExtensionAPI): void {
  pi.registerCommand("diff", {
    description: "审阅当前 Git 仓库的未提交差异并添加评论",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/diff 仅支持 Pi 交互终端", "error"); return; }
      const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
      if (rootResult.code !== 0) { ctx.ui.notify("当前目录不是 Git 项目，请进入项目目录后再使用 /diff", "warning"); return; }
      const root = rootResult.stdout.replace(/\r?\n$/, "");
      const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
      if (head.code !== 0) { ctx.ui.notify("仓库尚无提交，/diff 需要 HEAD 作为比较基线", "warning"); return; }
      const changed = await pi.exec("git", ["diff", "--name-only", "-z", "HEAD"], { cwd: root });
      const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
      if (changed.code !== 0 || untracked.code !== 0) { ctx.ui.notify("无法读取当前仓库的改动文件", "error"); return; }
      const entries: FileEntry[] = [
        ...changed.stdout.split("\0").filter(Boolean).map((path) => ({ path, untracked: false })),
        ...untracked.stdout.split("\0").filter(Boolean).map((path) => ({ path, untracked: true })),
      ];
      if (!entries.length) { ctx.ui.notify("当前仓库没有未提交改动", "info"); return; }
      // 未跟踪文件按新增文件显示；符号链接和大文件只展示说明，不读取目标内容。
      const load = async (entry: FileEntry): Promise<string> => {
        if (entry.untracked) {
          const info = await lstat(join(root, entry.path));
          if (info.isSymbolicLink()) return "符号链接未展开（可添加文件级评论）";
          if (info.size > 1024 * 1024) return "文件超过 1 MB，未加载正文（可添加文件级评论）";
        }
        const args = entry.untracked
          ? ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", entry.path]
          : ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", entry.path];
        const result = await pi.exec("git", args, { cwd: root });
        if (result.code !== 0 && !(entry.untracked && result.code === 1)) throw new Error("无法读取该文件差异，请退出后重新打开 /diff");
        if (result.stdout.length > 1024 * 1024) return "差异超过 1 MB，未加载正文（可添加文件级评论）";
        return result.stdout;
      };
      const response = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => new DiffPanel(entries, theme, load, () => tui.requestRender(), done));
      if (response) {
        const draft = ctx.ui.getEditorText();
        ctx.ui.setEditorText(draft ? `${draft}\n\n${response}` : response);
      }
    },
  });
}
