import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Input, matchesKey, SelectList, stripTerminalSequences, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";

type FileEntry = { path: string; status: string; oldPath?: string; untracked: boolean };
type DiffRow = { text: string; kind: "added" | "removed" | "hunk" | "context" | "meta"; oldLine?: number; newLine?: number };
type CompareRow = { before?: DiffRow; after?: DiffRow; note?: string };
type Comment = { path: string; row: CompareRow; side: "old" | "new"; text: string };
type ImagePreview = { before?: string[]; after?: string[]; columns: number; warning?: string };

/** 将 Git 状态映射到 Pi 当前主题的语义颜色。 */
function statusColor(status: string): ThemeColor {
  return status === "A" ? "success" : status === "M" ? "warning" : status === "D" ? "error" : status === "R" ? "accent" : "muted";
}

/** 清除差异与文件名中的终端控制字符，防止内容影响界面。 */
function safeDisplay(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => char === "\t" ? "  " : "�");
}

/** 有界读取本机命令的二进制输出，避免 Git 图片字节经过 UTF-8 文本接口。 */
function binaryOutput(command: string, args: string[], input: Buffer | undefined, cwd: string | undefined, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { child.kill(); reject(new Error("图片超过 8 MB，无法预览")); }
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} 无法读取或解码图片`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

/** 使用真彩色半块字符将一张缩小后的 RGB 图像绘成终端行。 */
export function ansiThumbnail(rgb: Buffer, columns: number, rows: number): string[] {
  if (rgb.length !== columns * rows * 6) throw new Error("图片解码后的像素数量不正确");
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < columns; x++) {
      const upper = (y * 2 * columns + x) * 3;
      const lower = upper + columns * 3;
      line += `\x1b[38;2;${rgb[upper]};${rgb[upper + 1]};${rgb[upper + 2]}m\x1b[48;2;${rgb[lower]};${rgb[lower + 1]};${rgb[lower + 2]}m▀`;
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

/** 用本机 ffmpeg 只取首帧，按固定终端格子生成有界缩略图。 */
async function thumbnail(data: Buffer, columns: number): Promise<string[]> {
  const rows = 14;
  const height = rows * 2;
  const rgb = await binaryOutput("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-i", "pipe:0", "-frames:v", "1", "-vf", `scale=${columns}:${height}:force_original_aspect_ratio=decrease,pad=${columns}:${height}:(ow-iw)/2:(oh-ih)/2:black`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], data, undefined, columns * height * 3);
  return ansiThumbnail(rgb, columns, rows);
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

/** 将统一差异中的相邻旧/新行配对，使修改在同一行左右对齐。 */
export function comparePatch(patch: string): CompareRow[] {
  const result: CompareRow[] = [];
  const removed: DiffRow[] = [];
  const added: DiffRow[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) result.push({ before: removed[i], after: added[i] });
    removed.length = 0;
    added.length = 0;
  };
  for (const row of parsePatch(patch)) {
    if (row.kind === "removed") removed.push(row);
    else if (row.kind === "added") added.push(row);
    else {
      flush();
      if (row.kind === "context") result.push({ before: row, after: row });
      else if (row.kind === "hunk") result.push({ note: row.text });
      else if (!/^(diff --git|index |--- |\+\+\+ |new file mode |deleted file mode )/.test(row.text)) result.push({ note: row.text });
    }
  }
  flush();
  return result.length ? result : [{ note: "（空文件或没有可显示的文本差异）" }];
}

/** 将连续的新增或删除行合并为一处可跳转的变更。 */
function changeStarts(rows: CompareRow[]): number[] {
  const changed = (row?: CompareRow) => row?.before?.kind === "removed" || row?.after?.kind === "added";
  return rows.flatMap((row, index) => changed(row) && !changed(rows[index - 1]) ? [index] : []);
}

/** 截短嵌入内容等超长单行，防止评论草稿被整个大文件撑满。 */
function excerpt(text: string): string {
  return safeDisplay(text.slice(0, 160)) + (text.length > 160 ? "…（长行已截断）" : "");
}

/** 将多条定位评论放入草稿，明确差异不一定由 AI 产生。 */
function commentDraft(comments: Comment[]): string {
  return ["请审阅当前仓库未提交的改动，并逐条处理以下评论（改动可能包含我手动修改的内容）：", ...comments.map(({ path, row, side, text }, index) => {
    const selected = side === "old" ? row.before : row.after;
    const location = selected?.oldLine && side === "old" ? `${path}:${selected.oldLine}（旧行）` : selected?.newLine ? `${path}:${selected.newLine}` : path;
    const change = row.note ?? `旧：${excerpt(row.before?.text ?? "∅")} → 新：${excerpt(row.after?.text ?? "∅")}`;
    return `${index + 1}. ${safeDisplay(location)}\n   差异：${safeDisplay(change)}\n   评论：${text}`;
  })].join("\n\n");
}

/** 在终端浏览工作区差异、批注并统一送入 Pi 草稿的只读组件。 */
export class DiffPanel {
  private mode: "files" | "diff" | "image" | "comment" = "files";
  private previousMode: "diff" | "image" = "diff";
  private input = new Input();
  private commentInput = new Input();
  private list!: SelectList;
  private readonly options: SelectItem[];
  private readonly entries: FileEntry[];
  private readonly theme: Theme;
  private readonly load: (entry: FileEntry, columns: number) => Promise<string | ImagePreview>;
  private readonly refresh: () => void;
  private readonly done: (value?: string) => void;
  private entry?: FileEntry;
  private rows: CompareRow[] = [];
  private changes: number[] = [];
  private image?: ImagePreview;
  private viewWidth = 100;
  private index = 0;
  private commentSide: "old" | "new" = "new";
  private top = 0;
  private comments: Comment[] = [];
  private message = "";
  private busy = false;
  focused = true;

  /** 初始化筛选列表与差异读取回调。 */
  constructor(entries: FileEntry[], theme: Theme, load: (entry: FileEntry, columns: number) => Promise<string | ImagePreview>, refresh: () => void, done: (value?: string) => void) {
    this.entries = entries;
    this.theme = theme;
    this.load = load;
    this.refresh = refresh;
    this.done = done;
    this.options = entries.map((entry, index) => ({ value: String(index), label: `${entry.status[0]}  ${safeDisplay(entry.path)}` }));
    this.filter("");
  }

  /** 按文件名筛选差异文件。 */
  private filter(query: string): void {
    this.list = new SelectList(this.options.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())), 14, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => {
        // 列表自带的选中颜色会覆盖整行；重新为状态标记着色，文件名仍保持强调色。
        const plain = stripTerminalSequences(text);
        return this.theme.fg("accent", plain.slice(0, 2))
          + this.theme.fg(statusColor(plain[2] ?? ""), plain[2] ?? "")
          + this.theme.fg("accent", plain.slice(3));
      },
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "  没有匹配的文件"),
    }, {
      truncatePrimary: ({ text, maxWidth }) => {
        const shown = truncateToWidth(text, maxWidth, "");
        return this.theme.fg(statusColor(shown[0] ?? ""), shown[0] ?? "") + shown.slice(1);
      },
    });
    this.list.onSelect = (item) => { void this.open(this.entries[Number(item.value)]!); };
    this.list.onCancel = () => this.leave();
  }

  /** 读取选中的单个文件差异，避免预先装载整个仓库。 */
  private async open(entry: FileEntry): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const columns = Math.max(8, Math.min(48, Math.floor((this.viewWidth - 4) / 2)));
      const content = await this.load(entry, columns);
      this.entry = entry;
      this.image = typeof content === "string" ? undefined : content;
      this.rows = typeof content === "string" ? comparePatch(content) : [{ note: "图片预览（文件级评论）" }];
      this.changes = this.image ? [] : changeStarts(this.rows);
      this.index = 0;
      this.top = 0;
      this.mode = this.image ? "image" : "diff";
      this.message = "";
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally { this.busy = false; this.refresh(); }
  }

  /** 跳到前后变更块的起点，到边界后循环，避免逐行翻找。 */
  private jumpChange(direction: 1 | -1): void {
    if (!this.changes.length) { this.message = "当前文件没有可跳转的文本差异"; return; }
    const current = this.rows[this.index];
    const onChange = current?.before?.kind === "removed" || current?.after?.kind === "added";
    const currentStart = onChange ? this.changes.filter((index) => index <= this.index).at(-1)! : this.index;
    const target = direction === 1
      ? this.changes.find((index) => index > this.index) ?? this.changes[0]!
      : this.changes.filter((index) => index < currentStart).at(-1) ?? this.changes.at(-1)!;
    this.index = target;
    this.message = `第 ${this.changes.indexOf(target) + 1}/${this.changes.length} 处差异`;
  }

  /** 保存当前差异行的单条评论，空内容不加入列表。 */
  private saveComment(): void {
    const text = this.commentInput.getValue().trim();
    if (text && this.entry) this.comments.push({ path: this.entry.path, row: this.rows[this.index]!, side: this.commentSide, text });
    this.commentInput = new Input();
    this.mode = this.previousMode;
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
      if (matchesKey(data, "escape")) { this.commentInput = new Input(); this.mode = this.previousMode; }
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
      else if (this.mode === "diff" && (data === "n" || data === "N")) this.jumpChange(data === "n" ? 1 : -1);
      else if (data === "c" || data === "C") {
        this.commentSide = data === "C" && this.rows[this.index]?.before ? "old" : this.rows[this.index]?.after ? "new" : this.rows[this.index]?.before ? "old" : "new";
        this.commentInput = new Input();
        this.previousMode = this.mode;
        this.mode = "comment";
      }
    }
    this.refresh();
  }

  /** 用语义颜色呈现增删行、位置及评论编辑框。 */
  render(width: number): string[] {
    this.viewWidth = width;
    // 超长嵌入行只截取可见前缀渲染；完整内容和行号仍保留在差异模型中。
    const fit = (text: string, columns = width - 1, pad = false) => {
      const prefix = text.slice(0, Math.max(80, columns * 4));
      return truncateToWidth(safeDisplay(prefix + (prefix.length < text.length ? "…" : "")), Math.max(1, columns), "…", pad);
    };
    const fg = this.theme.fg.bind(this.theme);
    const heading = fg("accent", fit(" DIFF  /  工作区审阅"));
    const note = fg("muted", fit(` HEAD → 当前工作区 · ${this.entries.length} 个文件 · ${this.comments.length} 条评论 · 可能包含手动改动`));
    if (this.mode === "files") {
      this.input.focused = this.focused;
      return [heading, note, ...this.input.render(width), ...this.list.render(width), ...(this.message ? [fg("warning", fit(` ${this.message}`))] : []), fg("dim", fit(" 输入筛选  ↑↓ 选择  Enter 打开  S 送出评论  Esc 退出"))];
    }
    const status = this.entry?.status[0] === "A" ? "新增" : this.entry?.status[0] === "D" ? "删除" : this.entry?.status[0] === "R" ? "重命名" : this.entry?.status[0] === "C" ? "复制" : "修改";
    const file = fg("accent", fit(` ${status} · ${this.entry?.path ?? ""}`));
    if (this.mode === "comment") {
      this.commentInput.focused = this.focused;
      const row = this.rows[this.index];
      const selected = this.commentSide === "old" ? row?.before : row?.after;
      const location = selected?.newLine ?? selected?.oldLine ?? "文件";
      return [heading, file, fg("muted", fit(` 评论${this.commentSide === "old" ? "旧版" : "当前版"}位置：${location} · ${selected?.text ?? row?.note ?? ""}`)), ...this.commentInput.render(width), fg("dim", fit(" Enter 保存评论  Esc 取消"))];
    }
    if (this.mode === "image" && this.image) {
      const columns = this.image.columns;
      const sides = fg("muted", fit("旧版 HEAD", columns, true) + " │ " + fit("当前工作区", columns));
      const height = Math.max(this.image.before?.length ?? 0, this.image.after?.length ?? 0);
      const pixels = Array.from({ length: height }, (_, index) => {
        const left = this.image?.before?.[index] ?? " ".repeat(columns);
        const right = this.image?.after?.[index] ?? " ".repeat(columns);
        return left + fg("muted", " │ ") + right;
      });
      return [heading, file, note, sides,
        ...(this.image.warning ? [fg("warning", fit(` ${this.image.warning}`))] : pixels),
        ...(this.message ? [fg("warning", fit(` ${this.message}`))] : []),
        fg("dim", fit(" 图片预览（缩略图）  c 评论当前版  C 评论旧版  S 放入输入框  Esc 文件  q 退出"))];
    }
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + 18) this.top = this.index - 17;
    const leftWidth = Math.max(1, Math.floor((width - 4) / 2));
    const rightWidth = Math.max(1, width - leftWidth - 4);
    const headings = fg("muted", fit(" 旧版 HEAD", leftWidth, true) + " │ " + fit(" 当前工作区", rightWidth));
    const rows = this.rows.slice(this.top, this.top + 18).map((row, offset) => {
      const current = this.top + offset === this.index;
      if (row.note) {
        const note = fg("accent", fit(` ${current ? "›" : " "} ${row.note}`));
        return current ? this.theme.bg("selectedBg", note) : note;
      }
      const before = row.before;
      const after = row.after;
      const left = fit(` ${current ? "›" : " "} ${String(before?.oldLine ?? "").padStart(4)} ${before?.text.slice(1) ?? ""}`, leftWidth, true);
      const right = fit(` ${String(after?.newLine ?? "").padStart(4)} ${after?.text.slice(1) ?? ""}`, rightWidth);
      const styled = fg(before?.kind === "removed" ? "toolDiffRemoved" : "text", left)
        + fg("muted", " │ ") + fg(after?.kind === "added" ? "toolDiffAdded" : "text", right);
      return current ? this.theme.bg("selectedBg", styled) : styled;
    });
    return [heading, file, note, headings, ...rows, ...(this.message ? [fg("warning", fit(` ${this.message}`))] : []), fg("dim", fit(" ↑↓ 逐行  n 下一处  N 上一处  PgUp/PgDn 翻页  c/C 评论  S 放入输入框  Esc 文件  q 退出"))];
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
      const changed = await pi.exec("git", ["diff", "-M", "--name-status", "-z", "HEAD"], { cwd: root });
      const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
      if (changed.code !== 0 || untracked.code !== 0) { ctx.ui.notify("无法读取当前仓库的改动文件", "error"); return; }
      const fields = changed.stdout.split("\0").filter(Boolean);
      const entries: FileEntry[] = [];
      for (let i = 0; i < fields.length;) {
        const status = fields[i++]!;
        const oldPath = /^[RC]/.test(status) ? fields[i++] : undefined;
        entries.push({ status, oldPath, path: fields[i++]!, untracked: false });
      }
      entries.push(...untracked.stdout.split("\0").filter(Boolean).map((path) => ({ path, status: "A", untracked: true })));
      if (!entries.length) { ctx.ui.notify("当前仓库没有未提交改动", "info"); return; }
      // 未跟踪文本按空旧版与完整新文件比较；只限制载入大小，不因超过 1 MB 拒绝审阅。
      const load = async (entry: FileEntry, columns: number): Promise<string | ImagePreview> => {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(extname(entry.path))) {
          if (!getCapabilities().trueColor) return { columns, warning: "当前终端不支持真彩色图片缩略预览" };
          try {
            const before = entry.status[0] === "A" ? undefined
              : await binaryOutput("git", ["show", `HEAD:${entry.oldPath ?? entry.path}`], undefined, root, 8 * 1024 * 1024);
            let after: Buffer | undefined;
            if (entry.status[0] !== "D") {
              const path = join(root, entry.path);
              const info = await lstat(path);
              if (info.isSymbolicLink()) return { columns, warning: "符号链接未展开（可添加文件级评论）" };
              if (info.size > 8 * 1024 * 1024) return { columns, warning: "图片超过 8 MB，未加载预览" };
              after = await readFile(path);
            }
            return { columns, before: before ? await thumbnail(before, columns) : undefined,
              after: after ? await thumbnail(after, columns) : undefined };
          } catch (error) {
            return { columns, warning: error instanceof Error ? `无法预览图片：${error.message}` : "无法预览图片" };
          }
        }
        if (entry.untracked) {
          const info = await lstat(join(root, entry.path));
          if (info.isSymbolicLink()) return "符号链接未展开（可添加文件级评论）";
          if (info.size > 8 * 1024 * 1024) return "文件超过 8 MB，未加载正文（可添加文件级评论）";
          const content = await readFile(join(root, entry.path));
          if (content.includes(0)) return "二进制文件未展开（可添加文件级评论）";
          const text = content.toString("utf8").replace(/\r\n/g, "\n");
          if (!text) return "新建空文件（可添加文件级评论）";
          const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
          return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
        }
        const paths = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
        const result = await pi.exec("git", ["diff", "-M", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...paths], { cwd: root });
        if (result.code !== 0) throw new Error("无法读取该文件差异，请退出后重新打开 /diff");
        if (result.stdout.length > 8 * 1024 * 1024) return "差异超过 8 MB，未加载正文（可添加文件级评论）";
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
