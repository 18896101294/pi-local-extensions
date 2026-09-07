import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  copyRichTextToClipboard,
  createRichClipboardPayload,
  findLastAssistantMarkdown,
  listAssistantMarkdown,
} from "./core.ts";
import { HistorySelector } from "./history-selector.ts";

/** 将指定 Markdown 写入富文本剪贴板并反馈结果。 */
async function copyMarkdown(markdown: string, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const payload = createRichClipboardPayload(markdown);
    await copyRichTextToClipboard(payload);
    ctx.ui.notify("已复制富文本，可直接粘贴到飞书", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`富文本复制失败：${message}`, "error");
  }
}

/** 注册当前回复与历史回复的富文本复制命令。 */
export default function copyRichExtension(pi: ExtensionAPI): void {
  pi.registerCommand("copy-rich", {
    description: "将最后一条助手回复复制为可粘贴到飞书的富文本",
    handler: async (_args, ctx) => {
      const markdown = findLastAssistantMarkdown(ctx.sessionManager.getBranch());
      if (!markdown) {
        ctx.ui.notify("没有可复制的助手回复", "error");
        return;
      }

      await copyMarkdown(markdown, ctx);
    },
  });

  pi.registerCommand("copy-rich-history", {
    description: "选择一条历史助手回复并复制为可粘贴到飞书的富文本",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/copy-rich-history 仅支持交互模式", "error");
        return;
      }

      const messages = listAssistantMarkdown(ctx.sessionManager.getBranch());
      if (messages.length === 0) {
        ctx.ui.notify("没有可复制的历史助手回复", "error");
        return;
      }

      const selectedMarkdown = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) =>
          new HistorySelector(
            messages,
            theme,
            keybindings,
            done,
            () => done(undefined),
            () => tui.requestRender(),
          ),
      );
      if (selectedMarkdown) await copyMarkdown(selectedMarkdown, ctx);
    },
  });
}
