import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
