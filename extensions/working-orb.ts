import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TYPING_REMINDER_WIDGET = "typing-reminder";
const MOON_PHASE_FRAMES = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const MOON_PHASE_INTERVAL_MS = 120;

/** 按 Pi 默认 footer 的规则缩写 token 数量。 */
function formatFooterTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** 保留 Pi 默认动画，并展示工作状态文字和输入提醒。 */
export default function workingMessage(pi: ExtensionAPI): void {
  let reminderTimer: ReturnType<typeof setInterval> | undefined;
  let reminderVisible = false;

  /** 根据输入框内容同步提醒文字的显示状态。 */
  function syncReminder(ctx: ExtensionContext): void {
    const shouldShow = ctx.ui.getEditorText().trim().length > 0;
    if (shouldShow === reminderVisible) return;

    reminderVisible = shouldShow;
    ctx.ui.setWidget(
      TYPING_REMINDER_WIDGET,
      shouldShow
        ? [ctx.ui.theme.fg("dim", "慢就是快，三思而后行")]
        : undefined,
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWorkingIndicator({
      frames: MOON_PHASE_FRAMES,
      intervalMs: MOON_PHASE_INTERVAL_MS,
    });
    ctx.ui.setWorkingMessage("许愿中...");
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        /** 将 Git 分支、上下文占用和模型信息合并为单行 footer。 */
        render(width: number): string[] {
          const usage = ctx.getContextUsage();
          const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercent = usage?.percent === null || usage?.percent === undefined
            ? "?"
            : usage.percent.toFixed(1);
          const contextText = contextPercent === "?"
            ? `?/${formatFooterTokens(contextWindow)}`
            : `${contextPercent}%/${formatFooterTokens(contextWindow)}`;
          const branch = footerData.getGitBranch();
          const left = branch ? `${branch} - ${contextText}` : contextText;

          const model = ctx.model;
          const modelText = model?.id ?? "no-model";
          const thinkingText = model?.reasoning
            ? ` • ${ctx.thinkingLevel === "off" ? "thinking off" : (ctx.thinkingLevel ?? "off")}`
            : "";
          const right = model ? `(${model.provider}) ${modelText}${thinkingText}` : modelText;
          const padding = " ".repeat(
            Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
          );
          return [
            truncateToWidth(
              theme.fg("dim", left) + padding + theme.fg("dim", right),
              width,
              "",
            ),
          ];
        },
        invalidate(): void {},
        dispose(): void {
          unsubscribeBranch();
        },
      };
    });
    reminderTimer = setInterval(() => syncReminder(ctx), 100);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = undefined;
    reminderVisible = false;
    ctx.ui.setWidget(TYPING_REMINDER_WIDGET, undefined);
  });
}
