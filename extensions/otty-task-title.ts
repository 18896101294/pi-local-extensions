import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "set_otty_task_title";
const TITLE_MAX_LENGTH = 20;

/**
 * 规范化任务标题，避免换行、装饰符号和过长文本污染 Otty 标签。
 */
function normalizeTitle(title: string): string {
  return title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^[·•\-—:：\s]+|[·•\-—:：\s]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, TITLE_MAX_LENGTH);
}

/**
 * 将任务标题写入终端标题，由 Otty 的 OSC 标题支持同步到当前标签。
 */
function applyTitle(ctx: ExtensionContext, title: string): void {
  ctx.ui.setTitle(`· ${title}`);
}

/**
 * 从当前会话分支恢复最近一次成功设置的任务标题。
 */
function restoreTaskTitle(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (entry.message.toolName !== TOOL_NAME) continue;

    const details = entry.message.details as { title?: unknown; applied?: unknown } | undefined;
    if (details?.applied !== true || typeof details.title !== "string") continue;

    const title = normalizeTitle(details.title);
    if (title) return title;
  }
  return undefined;
}

/**
 * 注册 Otty 任务标题工具，并维护会话恢复和手动命名的优先级。
 */
export default function ottyTaskTitleExtension(pi: ExtensionAPI): void {
  let currentTaskTitle: string | undefined;
  let restoreTitleTimer: ReturnType<typeof setTimeout> | undefined;

  pi.registerTool({
    name: TOOL_NAME,
    label: "设置 Otty 任务标签",
    description:
      "当用户开始新的实质任务或任务目标明显变化时，用 8～16 个中文字符概括任务并更新 Otty 标签。普通追问、补充说明、确认或继续执行时不要调用。",
    promptSnippet: "用简短语义标题更新 Otty 标签",
    promptGuidelines: [
      "当用户开始新的实质任务或当前任务目标明显变化时，先调用 set_otty_task_title；标题应使用 8～16 个中文字符概括动作与对象，不包含项目名、分支名、标点或“处理/任务”等空泛词。",
      "当用户只是追问、补充、确认、要求继续或纠正当前任务时，不要调用 set_otty_task_title；已有标签应保持不变。",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "8～16 个中文字符的任务摘要，例如：优化 Otty 标签命名",
        minLength: 2,
        maxLength: TITLE_MAX_LENGTH,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manualName = pi.getSessionName();
      if (manualName) {
        const title = normalizeTitle(manualName);
        if (title) applyTitle(ctx, title);
        return {
          content: [{ type: "text", text: `保留手动会话名称：${title}` }],
          details: { title, applied: false, reason: "manual-session-name" },
        };
      }

      const title = normalizeTitle(params.title);
      if (!title) throw new Error("任务标题不能为空");

      currentTaskTitle = title;
      applyTitle(ctx, title);
      return {
        content: [{ type: "text", text: `Otty 标签已更新为：${title}` }],
        details: { title, applied: true },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const manualName = pi.getSessionName();
    currentTaskTitle = manualName ? undefined : restoreTaskTitle(ctx);
    const title = normalizeTitle(manualName ?? currentTaskTitle ?? "");
    if (!title) return;

    applyTitle(ctx, title);
    if (restoreTitleTimer) clearTimeout(restoreTitleTimer);
    // Pi 会在 session_start 处理完成后写入内置标题，下一轮事件循环中再次应用任务标题。
    restoreTitleTimer = setTimeout(() => {
      restoreTitleTimer = undefined;
      applyTitle(ctx, title);
    }, 0);
  });

  pi.on("session_shutdown", async () => {
    if (!restoreTitleTimer) return;
    clearTimeout(restoreTitleTimer);
    restoreTitleTimer = undefined;
  });

  pi.on("session_info_changed", async (event, ctx) => {
    const title = normalizeTitle(event.name ?? currentTaskTitle ?? "");
    if (title) applyTitle(ctx, title);
  });
}
