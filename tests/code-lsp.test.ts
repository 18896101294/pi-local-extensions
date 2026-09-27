import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LspClient, type Location } from "../extensions/code/lsp.ts";
import { CodePanel } from "../extensions/code/index.ts";

/** 使用真实 clangd 验证 LSP 协议与跨位置跳转，而不依赖测试替身。 */
test("代码面板可沿着 clangd 的定义位置跳转", async (t) => {
  try { execFileSync("clangd", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("本机未安装 clangd"); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-navigation-")));
  const file = join(root, "main.c");
  writeFileSync(file, "int amount = 3;\nint main(void) { return amount; }\n");
  const panel = new CodePanel(root, ["main.c"], { fg: (_color: string, text: string) => text } as any, () => {}, () => {});
  /** 等待语言服务器更新组件，不用固定睡眠断言异步结果。 */
  async function until(text: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (panel.render(120).join("\n").includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`未出现 ${text}`);
  }
  try {
    panel.handleInput("\r");
    await until("clangd 已连接");
    panel.handleInput("\x1b[B");
    for (let i = 0; i < 25; i++) panel.handleInput("\x1b[C");
    panel.handleInput("g");
    await until("main.c:1");
    panel.handleInput("\r");
    await until(" 1:5");
  } finally { panel.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("clangd 的诊断会更新只读面板可查询的结果", async (t) => {
  try { execFileSync("clangd", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("本机未安装 clangd"); return; }
  const root = mkdtempSync(join(tmpdir(), "pi-code-diagnostics-"));
  const file = join(root, "main.c");
  const text = "int main(void) { return unknown_name; }\n";
  writeFileSync(file, text);
  const client = new LspClient("clangd");
  try {
    await client.initialize(root);
    const diagnostic = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("未收到诊断")), 2500);
      client.onDiagnostics = (_uri, items) => {
        if (items.some((item) => item.message.includes("unknown_name"))) { clearTimeout(timer); resolve(); }
      };
    });
    client.open(file, "c", text);
    await diagnostic;
    assert.ok(client.getDiagnostics(file).length > 0);
  } finally { client.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("已安装的 sourcekit-lsp 可跳转 Swift 变量定义", async (t) => {
  try { execFileSync("sourcekit-lsp", ["--help"], { stdio: "ignore", timeout: 2000 }); }
  catch { t.skip("本机未安装 sourcekit-lsp"); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-swift-")));
  const file = join(root, "main.swift");
  const text = "let amount = 3\nprint(amount)\n";
  writeFileSync(file, text);
  const client = new LspClient("sourcekit-lsp");
  try {
    await client.initialize(root);
    client.open(file, "swift", text);
    const result = await client.query("textDocument/definition", file, { line: 1, character: 7 });
    const location = (Array.isArray(result) ? result[0] : result) as Location;
    assert.equal(location.range.start.line, 0);
  } finally { client.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("clangd 能返回 C 变量定义位置", async (t) => {
  try { execFileSync("clangd", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("本机未安装 clangd"); return; }
  const root = mkdtempSync(join(tmpdir(), "pi-code-lsp-"));
  const file = join(root, "main.c");
  const text = "int amount = 3;\nint main(void) { return amount; }\n";
  writeFileSync(file, text);
  const client = new LspClient("clangd");
  try {
    await client.initialize(root);
    client.open(file, "c", text);
    const result = await client.query("textDocument/definition", file, { line: 1, character: 25 });
    const location = Array.isArray(result) ? result[0] : result as Location;
    assert.equal(location.range.start.line, 0);
    const references = await client.query("textDocument/references", file, { line: 1, character: 25 }) as Location[];
    assert.ok(references.length >= 2, "定义和使用处都应出现在引用列表中");
    const hover = await client.query("textDocument/hover", file, { line: 1, character: 25 }) as { contents: unknown };
    assert.ok(hover?.contents, "悬停应返回变量信息");
  } finally {
    client.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
