import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

/** 注册当前 Git 仓库的本地分支选择与切换命令。 */
export default function branchExtension(pi: ExtensionAPI): void {
  pi.registerCommand("branch", {
    description: "查看并切换当前仓库的本地 Git 分支",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/branch 仅支持交互模式", "error");
        return;
      }

      // 所有 Git 命令都绑定会话目录，避免误操作扩展自身所在的仓库。
      const branches = await pi.exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: ctx.cwd });
      if (branches.code !== 0) {
        ctx.ui.notify(`读取分支失败：${branches.stderr.trim() || "当前目录不是 Git 仓库"}`, "error");
        return;
      }
      const names = branches.stdout.trimEnd().split("\n").filter(Boolean);
      if (names.length === 0) {
        ctx.ui.notify("当前仓库还没有本地分支", "warning");
        return;
      }
      const head = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ctx.cwd });
      const current = head.code === 0 ? head.stdout.trim() : undefined;
      const ordered = [...names].sort((a, b) => Number(b === current) - Number(a === current) || a.localeCompare(b));
      const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
        const items: SelectItem[] = ordered.map((name) => ({
          value: name,
          label: name,
          description: name === current ? "当前分支" : undefined,
        }));
        const input = new Input();
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("切换 Git 分支")), 0, 0));
        container.addChild(input);
        const listIndex = container.children.length;
        let list: SelectList;

        /** 根据输入重建筛选后的列表，保留键盘选择行为。 */
        function filter(query: string): void {
          const matches = items.filter((item) => item.value.toLowerCase().includes(query.toLowerCase()));
          list = new SelectList(matches, 10, {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(undefined);
          container.children[listIndex] = list;
        }

        filter("");
        container.addChild(new Text(theme.fg("dim", "输入筛选 · ↑↓ 选择 · Enter 切换 · Esc 取消"), 0, 0));
        return {
          get focused() { return input.focused; },
          set focused(value: boolean) { input.focused = value; },
          render(width: number) { return container.render(width); },
          invalidate() { container.invalidate(); },
          handleInput(data: string) {
            // 选择键交给列表，其余输入交给搜索框。
            if (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((key) => keys.matches(data, key))) {
              list.handleInput(data);
            } else {
              input.handleInput(data);
              filter(input.getValue());
            }
            tui.requestRender();
          },
        };
      });
      if (!selected || selected === current) return;

      // 不使用强制切换或自动 stash；冲突由 Git 拒绝并原样反馈。
      const result = await pi.exec("git", ["switch", "--", selected], { cwd: ctx.cwd });
      if (result.code !== 0) {
        ctx.ui.notify(`切换失败：${result.stderr.trim() || result.stdout.trim()}`, "error");
        return;
      }
      const verified = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ctx.cwd });
      ctx.ui.notify(
        verified.code === 0 && verified.stdout.trim() === selected ? `已切换到分支 ${selected}` : `切换命令已执行，但无法确认当前分支是 ${selected}`,
        verified.code === 0 && verified.stdout.trim() === selected ? "info" : "warning",
      );
    },
  });
}
