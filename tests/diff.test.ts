import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import diffExtension from "../extensions/diff/index.ts";

/** 创建隔离 Git 仓库，覆盖已暂存、未暂存和未跟踪改动。 */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-diff-")));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "source.txt"), "old\nkeep\n");
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"], { cwd: root });
  writeFileSync(join(root, "source.txt"), "new\nkeep\n");
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  writeFileSync(join(root, "source.txt"), "new\nkeep\nextra\n");
  writeFileSync(join(root, "notes.txt"), "note\n");
  return root;
}

/** 使用真实 Git 命令模拟 Pi 的只读执行接口。 */
function setup(cwd: string) {
  let handler: (args: string, ctx: any) => Promise<void>;
  let draft = "原有问题";
  const notices: Array<[string, string]> = [];
  let drive: (panel: any) => Promise<void> = async (panel) => { panel.handleInput("\x1b"); };
  diffExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    exec: async (command: string, args: string[], options: { cwd: string }) => {
      try { return { code: 0, stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
      catch (error: any) { return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "" }; }
    },
  } as any);
  const ctx = { cwd, mode: "tui", ui: {
    notify: (message: string, level: string) => notices.push([message, level]),
    getEditorText: () => draft,
    setEditorText: (text: string) => { draft = text; },
    custom: (factory: any) => new Promise((resolve, reject) => {
      try {
        const panel = factory({ requestRender() {} }, { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value }, null, resolve);
        void drive(panel).catch(reject);
      } catch (error) { reject(error); }
    }),
  } };
  return { notices, run: () => handler!("", ctx), getDraft: () => draft, drive: (fn: typeof drive) => { drive = fn; } };
}

/** 等待异步 Git 差异加载完成。 */
async function until(panel: any, text: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const view = panel.render(100).join("\n");
    if (view.includes(text)) return view;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`差异面板未出现 ${text}`);
}

test("/diff 包含暂存、未暂存和未跟踪文件，不声称都是 AI 改动", async () => {
  const root = repo();
  const command = setup(root);
  try {
    command.drive(async (panel) => {
      const menu = panel.render(100).join("\n");
      assert.match(menu, /source\.txt/);
      assert.match(menu, /notes\.txt/);
      assert.match(menu, /可能包含手动改动/);
      for (const char of "notes") panel.handleInput(char);
      panel.handleInput("\r");
      assert.match(await until(panel, "+note"), /\+note/);
      assert.ok(panel.render(35).every((line: string) => visibleWidth(line) <= 35), "窄终端的差异行不应溢出");
      panel.handleInput("\x1b");
      panel.handleInput("\x1b");
    });
    await command.run();
    assert.equal(command.getDraft(), "原有问题");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("差异行评论可批量放入对话输入框，保留草稿且不改文件", async () => {
  const root = repo();
  const command = setup(root);
  const before = execFileSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8" });
  try {
    command.drive(async (panel) => {
      for (const char of "source") panel.handleInput(char);
      panel.handleInput("\r");
      const view = await until(panel, "+extra");
      assert.match(view, /-old/);
      assert.match(view, /\+new/);
      for (let i = 0; i < 25; i++) {
        if ((panel.render(100).find((line: string) => line.trimStart().startsWith("›")) ?? "").includes("+extra")) break;
        panel.handleInput("\x1b[B");
      }
      panel.handleInput("c");
      for (const char of "请解释这一行") panel.handleInput(char);
      panel.handleInput("\r");
      for (let i = 0; i < 25; i++) {
        if ((panel.render(100).find((line: string) => line.trimStart().startsWith("›")) ?? "").includes("-old")) break;
        panel.handleInput("\x1b[A");
      }
      panel.handleInput("c");
      for (const char of "删除原因？") panel.handleInput(char);
      panel.handleInput("\r");
      panel.handleInput("S");
    });
    await command.run();
    assert.match(command.getDraft(), /^原有问题\n\n/);
    assert.match(command.getDraft(), /source\.txt:3/);
    assert.match(command.getDraft(), /请解释这一行/);
    assert.match(command.getDraft(), /source\.txt:1（旧行）/);
    assert.match(command.getDraft(), /删除原因？/);
    assert.equal(execFileSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8" }), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("非 Git 目录给出易懂提示", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-not-git-diff-")));
  try {
    const command = setup(root);
    await command.run();
    assert.deepEqual(command.notices.at(-1), ["当前目录不是 Git 项目，请进入项目目录后再使用 /diff", "warning"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
