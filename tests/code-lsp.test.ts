import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LspClient, type Location } from "../extensions/code/lsp.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CodePanel } from "../extensions/code/index.ts";

initTheme("dark");

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

test("csharp-ls 能在 .NET 8 项目里查到接口的跨文件引用", async (t) => {
  const server = join(homedir(), ".dotnet", "tools", "csharp-ls");
  try { execFileSync(server, ["--version"], { stdio: "ignore" }); }
  catch { t.skip("未安装 csharp-ls"); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-csharp-")));
  const file = join(root, "IThing.cs");
  const text = "public interface IThing { void Run(); }\n";
  writeFileSync(join(root, "Demo.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  writeFileSync(file, text);
  writeFileSync(join(root, "Thing.cs"), "public class Thing : IThing { public void Run() {} }\n");
  writeFileSync(join(root, "Usage.cs"), "public class Usage { IThing value = new Thing(); }\n");
  execFileSync("dotnet", ["restore", "--ignore-failed-sources"], { cwd: root, stdio: "ignore", timeout: 30_000 });
  const client = new LspClient(server, [], root);
  try {
    await client.initialize(root);
    client.open(file, "csharp", text);
    await client.waitForWorkspaceLoad();
    const references = await client.query("textDocument/references", file, { line: 0, character: text.indexOf("IThing") + 2 }) as Location[];
    assert.ok(Array.isArray(references) && references.length >= 2, "应至少找到实现和使用处");
    assert.ok(references.some((item) => item.uri.endsWith("Thing.cs")));
    client.stop();

    const panel = new CodePanel(root, ["IThing.cs", "Thing.cs"], { fg: (_color: string, value: string) => value } as any, () => {}, () => {});
    /** 等待项目真正加载并显示引用列表，验证 r 不是只发送了请求。 */
    async function until(value: string): Promise<void> {
      for (let i = 0; i < 500; i++) {
        if (panel.render(120).join("\n").includes(value)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`C# 面板未出现：${value}`);
    }
    try {
      panel.handleInput("\r");
      await until("C# 项目已加载");
      for (let i = 0; i < text.indexOf("IThing") + 2; i++) panel.handleInput("\x1b[C");
      panel.handleInput("r");
      await until("Enter 跳转");
      assert.match(panel.render(35).join("\n"), /(?:^|[\s/])Thing\.cs:1/m, "窄终端也应看到引用所属文件");
      assert.doesNotMatch(panel.render(120).find((line) => line.includes("›")) ?? "", /IThing\.cs:1/, "默认选中引用而非当前位置的声明");
    } finally { panel.dispose(); }
  } finally { client.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("csharp-ls 加载 .sln 后识别解决方案就绪并查询接口引用", async (t) => {
  const server = join(homedir(), ".dotnet", "tools", "csharp-ls");
  try { execFileSync(server, ["--version"], { stdio: "ignore" }); }
  catch { t.skip("未安装 csharp-ls"); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-solution-")));
  const file = join(root, "IThing.cs");
  const text = "public interface IThing { void Run(); }\n";
  writeFileSync(join(root, "Demo.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  writeFileSync(file, text);
  writeFileSync(join(root, "Thing.cs"), "public class Thing : IThing { public void Run() {} }\n");
  execFileSync("dotnet", ["new", "sln", "-n", "Demo"], { cwd: root, stdio: "ignore", timeout: 10_000 });
  execFileSync("dotnet", ["sln", "Demo.sln", "add", "Demo.csproj"], { cwd: root, stdio: "ignore", timeout: 10_000 });
  execFileSync("dotnet", ["restore", "--ignore-failed-sources"], { cwd: root, stdio: "ignore", timeout: 30_000 });
  const client = new LspClient(server, [], root);
  try {
    await client.initialize(root);
    client.open(file, "csharp", text);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.waitForWorkspaceLoad(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("解决方案加载事件未被识别")), 5_000); }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); }
    const refs = await client.query("textDocument/references", file, { line: 0, character: text.indexOf("IThing") + 2 }) as Location[];
    assert.ok(refs.some((item) => item.uri.endsWith("Thing.cs")));
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
