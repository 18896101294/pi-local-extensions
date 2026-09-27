import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import codeExtension, { CodePanel, selectedCode } from "../extensions/code/index.ts";

const theme = { fg: (_name: string, text: string) => text } as any;

/** 等待面板异步读盘完成。 */
async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 25)); }

test("按行选区带来源供对话引用", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-panel-")));
  writeFileSync(join(root, "sample.txt"), "alpha\nbeta\ngamma\n");
  let selection: string | undefined;
  const panel = new CodePanel(root, ["sample.txt"], theme, () => {}, (value) => { selection = value; });
  try {
    panel.handleInput("\r");
    await tick();
    panel.handleInput("v");
    panel.handleInput("\x1b[B");
    panel.handleInput("y");
    assert.equal(selection, "sample.txt:1-2\n```\nalpha\nbeta\n```");
  } finally { panel.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("/code 保留原有草稿，只填入代码而不发送对话", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-command-")));
  writeFileSync(join(root, "sample.txt"), "answer\n");
  let handler: (args: string, ctx: any) => Promise<void>;
  let draft = "先解释这个逻辑";
  const pi = {
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    exec: async () => ({ code: 0, stdout: "sample.txt\n", stderr: "" }),
  };
  codeExtension(pi as any);
  try {
    await handler!("", { cwd: root, mode: "tui", ui: {
      getEditorText: () => draft,
      setEditorText: (text: string) => { draft = text; },
      notify: () => {},
      custom: (factory: any) => new Promise((resolve) => {
        const panel = factory({ requestRender() {} }, theme, null, resolve);
        panel.handleInput("\r");
        void tick().then(() => { panel.handleInput("v"); panel.handleInput("y"); });
      }),
    } });
    assert.equal(draft, "先解释这个逻辑\n\nsample.txt:1-1\n```\nanswer\n```");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("扫描遇到无权访问的目录仍展示已发现文件，并提示列表不完整", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-partial-")));
  let handler: (args: string, ctx: any) => Promise<void>;
  const notices: Array<[string, string]> = [];
  let opened = false;
  let args: string[] = [];
  codeExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    exec: async (_command: string, requested: string[]) => {
      args = requested;
      return { code: 2, stdout: "src/main.ts\n", stderr: "rg: Library: Permission denied (os error 13)" };
    },
  } as any);
  try {
    await handler!("", { cwd: root, mode: "tui", ui: {
      notify: (message: string, level: string) => notices.push([message, level]),
      custom: async () => { opened = true; return undefined; },
    } });
    assert.equal(opened, true);
    assert.ok(args.includes("--no-messages"));
    assert.match(notices[0]?.[0] ?? "", /部分目录无法访问/);
    assert.equal(notices[0]?.[1], "warning");
    assert.doesNotMatch(notices[0]?.[0] ?? "", /Permission denied/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("从主目录打开时不扫描百万文件，提示在项目目录启动 Pi", async () => {
  let handler: (args: string, ctx: any) => Promise<void>;
  const notices: Array<[string, string]> = [];
  let scanned = false;
  codeExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    exec: async () => { scanned = true; return { code: 2, stdout: "", stderr: "rg: Library: Permission denied" }; },
  } as any);
  await handler!("", { cwd: homedir(), mode: "tui", ui: { notify: (message: string, level: string) => notices.push([message, level]) } });
  assert.equal(scanned, false);
  assert.equal(notices.at(-1)?.[1], "warning");
  assert.match(notices.at(-1)?.[0] ?? "", /项目目录启动 Pi/);
  assert.doesNotMatch(notices.at(-1)?.[0] ?? "", /Permission denied/);
});

test("项目目录全都无法访问时不暴露系统错误", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-unreadable-")));
  let handler: (args: string, ctx: any) => Promise<void>;
  const notices: Array<[string, string]> = [];
  codeExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    exec: async () => ({ code: 2, stdout: "", stderr: "rg: private: Permission denied" }),
  } as any);
  try {
    await handler!("", { cwd: root, mode: "tui", ui: { notify: (message: string, level: string) => notices.push([message, level]) } });
    assert.equal(notices.at(-1)?.[1], "warning");
    assert.match(notices.at(-1)?.[0] ?? "", /项目目录/);
    assert.doesNotMatch(notices.at(-1)?.[0] ?? "", /Permission denied/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("代码视图按语言区分关键字、注释和字符串，高亮后仍不溢出终端", async () => {
  initTheme("dark");
  const keyword = highlightCode("export", "typescript")[0]!;
  const string = highlightCode('"hello"', "typescript")[0]!;
  const comment = highlightCode("// note", "typescript")[0]!;
  const activeTheme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => `\x1b[48;5;236m${value}\x1b[49m` } as any;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-syntax-")));
  writeFileSync(join(root, "example.ts"), 'export const answer = "hello";\n// note\n');
  const panel = new CodePanel(root, ["example.ts"], activeTheme, () => {}, () => {});
  try {
    panel.handleInput("\r");
    await tick();
    const output = panel.render(42);
    const code = output.find((item) => item.includes("export")) ?? "";
    assert.ok(code.includes(keyword), "export 应按关键字高亮");
    assert.ok(code.includes(string), "字符串应使用另一种颜色");
    assert.ok(output.find((item) => item.includes("// note"))?.includes(comment), "注释应独立着色");
    assert.ok(output.every((item) => visibleWidth(item) <= 42), "高亮不能破坏终端宽度");
    panel.handleInput("v");
    panel.handleInput("\x1b[B");
    const selected = panel.render(42);
    const selectedComment = selected.find((item) => item.includes("// note")) ?? "";
    assert.ok(selectedComment.includes("\x1b[48;5;236m"), "选区应有背景色");
    assert.ok(selectedComment.includes(comment.split("\x1b[39m")[0]!), "选区不能覆盖语法颜色");
  } finally { panel.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("代码中有反引号时选区围栏不会提前结束", () => {
  assert.equal(selectedCode("a.ts", ["const code = ```raw```;"], 0, 0), "a.ts:1-1\n````\nconst code = ```raw```;\n````");
});

test("符号链接不能将只读面板导航到项目外的文件", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-root-")));
  const outside = mkdtempSync(join(tmpdir(), "pi-code-outside-"));
  writeFileSync(join(outside, "secret.txt"), "do not show");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  const panel = new CodePanel(root, ["link.txt"], theme, () => {}, () => {});
  try {
    panel.handleInput("\r");
    await tick();
    assert.match(panel.render(80).join("\n"), /不在当前项目目录/);
    assert.doesNotMatch(panel.render(80).join("\n"), /do not show/);
  } finally { panel.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
