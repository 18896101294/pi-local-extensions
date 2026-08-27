import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 注册 OpenAI Codex Fast 模式开关。
 */
export default function (pi: ExtensionAPI) {
  let enabled = false;

  pi.registerCommand("fast", {
    description: "控制 OpenAI Codex Fast 模式：/fast on | /fast off",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();

      if (mode === "on") {
        enabled = true;
        ctx.ui.notify("OpenAI Codex Fast 模式已开启", "info");
        return;
      }

      if (mode === "off") {
        enabled = false;
        ctx.ui.notify("OpenAI Codex Fast 模式已关闭", "info");
        return;
      }

      ctx.ui.notify(
        `OpenAI Codex Fast 模式当前为 ${enabled ? "on" : "off"}；用法：/fast on | /fast off`,
        "info",
      );
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !enabled ||
      ctx.model?.provider !== "openai-codex" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      return;
    }

    // Fast 模式在 OpenAI Codex 请求中对应 priority 服务层级。
    return {
      ...event.payload,
      service_tier: "priority",
    };
  });
}
