import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import branchExtension from "../extensions/branch.ts";

/** 在临时仓库中验证分支命令，不改变实际项目的当前分支。 */
function withRepo(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-branch-"));
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", cwd, "branch", "feature/demo"]);
  return run(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

/** 模拟 Pi 的命令与 Git 执行接口，记录用户可见的结果。 */
function setup(cwd: string, mode = "tui") {
  let handler: (args: string, ctx: any) => Promise<void>;
  const notices: Array<[string, string]> = [];
  let select: (component: any) => void = (component) => component.handleInput("\x1b");
  const pi = {
    exec: async (command: string, args: string[], options: { cwd: string }) => {
      try {
        const stdout = execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, stdout, stderr: "" };
      } catch (error: any) {
        return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "" };
      }
    },
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
  };
  branchExtension(pi as any);
  const ctx = {
    cwd,
    mode,
    ui: {
      notify: (message: string, level: string) => notices.push([message, level]),
      custom: (factory: any) => new Promise((resolve, reject) => {
        try {
          const component = factory(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: (data: string, key: string) => data === ({ "tui.select.confirm": "\r", "tui.select.cancel": "\x1b", "tui.select.down": "\x1b[B" } as Record<string, string>)[key] },
            resolve,
          );
          select(component);
        } catch (error) { reject(error); }
      }),
    },
  };
  return { notices, run: () => handler("", ctx), choose: (fn: typeof select) => { select = fn; } };
}

test("从当前目录列出本地分支并切换，不操作其他仓库", async () => withRepo(async (cwd) => {
  const command = setup(cwd);
  command.choose((component) => {
    const display = component.render(80).join("\n");
    assert.match(display, /main/);
    assert.match(display, /feature\/demo/);
    component.handleInput("\x1b[B");
    component.handleInput("\r");
  });
  await command.run();
  assert.equal(execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(), "feature/demo");
  assert.deepEqual(command.notices.at(-1), ["已切换到分支 feature/demo", "info"]);
}));

test("可以输入部分名称筛选后切换", async () => withRepo(async (cwd) => {
  const command = setup(cwd);
  command.choose((component) => {
    for (const char of "demo") component.handleInput(char);
    const display = component.render(80).join("\n");
    assert.match(display, /feature\/demo/);
    assert.doesNotMatch(display, /当前分支/);
    component.handleInput("\r");
  });
  await command.run();
  assert.equal(execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(), "feature/demo");
}));

test("取消选择不会切换分支", async () => withRepo(async (cwd) => {
  await setup(cwd).run();
  assert.equal(execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
}));

test("切换遇到未提交改动冲突时，保持原分支并反馈 Git 错误", async () => withRepo(async (cwd) => {
  writeFileSync(join(cwd, "example.txt"), "feature\n");
  execFileSync("git", ["-C", cwd, "add", "example.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "main file"]);
  execFileSync("git", ["-C", cwd, "switch", "-q", "feature/demo"]);
  writeFileSync(join(cwd, "example.txt"), "branch\n");
  execFileSync("git", ["-C", cwd, "add", "example.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "branch file"]);
  execFileSync("git", ["-C", cwd, "switch", "-q", "main"]);
  writeFileSync(join(cwd, "example.txt"), "dirty\n");

  const command = setup(cwd);
  command.choose((component) => { component.handleInput("\x1b[B"); component.handleInput("\r"); });
  await command.run();
  assert.equal(execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  assert.equal(command.notices.at(-1)?.[1], "error");
  assert.equal(execFileSync("git", ["-C", cwd, "show", ":example.txt"], { encoding: "utf8" }), "feature\n");
}));

test("不在 Git 仓库时给出可操作的提示", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-not-git-"));
  try {
    const command = setup(cwd);
    await command.run();
    assert.deepEqual(command.notices.at(-1), ["当前目录不是 Git 项目，请进入 Git 项目目录后再使用 /branch", "warning"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
