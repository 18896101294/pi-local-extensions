import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  installHiddenThinkingRendering,
  installQuietToolRendering,
} from "./rendering.ts";

/**
 * 注册可开关的安静输出模式。
 */
export default function quietToolOutputExtension(pi: ExtensionAPI): void {
  let enabled = true;
  let restoreRendering: (() => void) | undefined;

  /**
   * 开启安静输出模式并刷新现有消息。
   */
  function enableQuietMode(ctx: ExtensionContext): void {
    if (!restoreRendering) {
      const restoreToolRendering = installQuietToolRendering(ToolExecutionComponent);
      const restoreThinkingRendering = installHiddenThinkingRendering(AssistantMessageComponent);
      restoreRendering = () => {
        restoreThinkingRendering();
        restoreToolRendering();
      };
    }
    enabled = true;
    ctx.ui.setHiddenThinkingLabel("");
  }

  /**
   * 关闭安静输出模式并恢复 Pi 官方渲染。
   */
  function disableQuietMode(ctx: ExtensionContext): void {
    restoreRendering?.();
    restoreRendering = undefined;
    enabled = false;
    ctx.ui.setHiddenThinkingLabel();
  }

  pi.registerCommand("quiet", {
    description: "控制安静输出模式（默认开启）：/quiet on | /quiet off",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();

      if (mode === "on") {
        enableQuietMode(ctx);
        ctx.ui.notify("安静输出模式已开启", "info");
        return;
      }

      if (mode === "off") {
        disableQuietMode(ctx);
        ctx.ui.notify("安静输出模式已关闭，已恢复 Pi 官方显示", "info");
        return;
      }

      ctx.ui.notify(
        `安静输出模式当前为 ${enabled ? "on" : "off"}；用法：/quiet on | /quiet off`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui" && enabled) enableQuietMode(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disableQuietMode(ctx);
  });
}
