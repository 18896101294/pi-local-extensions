import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installUserMessagePrefix } from "./rendering.ts";

const USER_MESSAGE_LABEL = process.env.PI_USER_MESSAGE_LABEL ?? "You: ";

/**
 * 注册高对比度用户消息前缀，并在会话关闭时恢复官方渲染。
 */
export default function userMessageFocusExtension(pi: ExtensionAPI): void {
  let restoreRendering: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || restoreRendering) return;
    restoreRendering = installUserMessagePrefix(
      UserMessageComponent,
      () => ctx.ui.theme.bold(ctx.ui.theme.fg("accent", USER_MESSAGE_LABEL)),
    );
  });

  pi.on("session_shutdown", async () => {
    restoreRendering?.();
    restoreRendering = undefined;
  });
}
