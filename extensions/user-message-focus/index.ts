import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installEditorPlaceholder, installUserMessagePrefix } from "./rendering.ts";

const USER_MESSAGE_LABEL = process.env.PI_USER_MESSAGE_LABEL ?? "You: ";
const EDITOR_PLACEHOLDER = "佛祖保佑，永无 BUG ！";

/**
 * 注册用户消息前缀与编辑器占位提示，并在会话关闭时恢复官方渲染。
 */
export default function userMessageFocusExtension(pi: ExtensionAPI): void {
  let restoreRendering: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || restoreRendering) return;
    const restoreMessagePrefix = installUserMessagePrefix(
      UserMessageComponent,
      () => ctx.ui.theme.bold(ctx.ui.theme.fg("accent", USER_MESSAGE_LABEL)),
    );
    const restoreEditorPlaceholder = installEditorPlaceholder(
      CustomEditor,
      EDITOR_PLACEHOLDER,
      (text) => ctx.ui.theme.fg("dim", text),
    );
    restoreRendering = () => {
      restoreEditorPlaceholder();
      restoreMessagePrefix();
    };
  });

  pi.on("session_shutdown", async () => {
    restoreRendering?.();
    restoreRendering = undefined;
  });
}
