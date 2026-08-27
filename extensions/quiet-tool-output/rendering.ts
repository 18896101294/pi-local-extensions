interface ToolExecutionRenderState {
  toolName: string;
  args: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string }>;
  };
}

interface ToolExecutionComponentLike {
  render(width: number): string[];
}

interface ToolExecutionComponentClass {
  prototype: ToolExecutionComponentLike;
}

interface AssistantMessage {
  content: Array<{ type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface AssistantMessageComponentLike {
  render(width: number): string[];
  updateContent(message: AssistantMessage, isStreaming?: boolean): void;
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  markdownTheme: unknown;
  outputPad: number;
  markdownTransformers: unknown[];
  lastMessage?: AssistantMessage;
  isStreaming: boolean;
}

interface AssistantMessageComponentClass {
  new (
    message?: AssistantMessage,
    hideThinkingBlock?: boolean,
    markdownTheme?: unknown,
    hiddenThinkingLabel?: string,
    outputPad?: number,
    markdownTransformers?: unknown[],
  ): AssistantMessageComponentLike;
  prototype: AssistantMessageComponentLike;
}

type TruncateToWidth = (text: string, width: number) => string;

const VISIBLE_SUCCESS_TOOLS = new Set(["edit", "write"]);

/**
 * 将工具参数压缩成适合单行状态展示的文本。
 */
function compactText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 100 ? `${compact.slice(0, 99)}…` : compact;
}

/**
 * 生成工具执行中的简短状态，优先展示命令、路径或搜索条件。
 */
function formatRunningStatus(toolName: string, args: unknown): string {
  const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const detail = [input.command, input.path, input.pattern, input.query].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const summary = detail ? `${toolName} · ${compactText(detail)}` : toolName;
  return `… 正在执行 ${summary}`;
}

/**
 * 安装安静工具渲染：执行中只显示一行，成功后隐藏，失败时保留原始错误卡片。
 */
export function installQuietToolRendering(
  componentClass: ToolExecutionComponentClass,
  truncateToWidth: TruncateToWidth,
): () => void {
  const prototype = componentClass.prototype;
  const originalRender = prototype.render;

  const quietRender = function (this: ToolExecutionComponentLike, width: number): string[] {
    const state = this as unknown as ToolExecutionRenderState;

    // 工具参数仍在生成时不显示；真正开始执行后仅保留一行状态。
    if (state.isPartial) {
      return state.executionStarted ? [truncateToWidth(formatRunningStatus(state.toolName, state.args), width)] : [];
    }

    // edit/write 和图片结果成功时保留原始卡片；其他成功结果隐藏，所有失败结果照常显示。
    const hasImage = state.result?.content?.some((content) => content.type === "image") ?? false;
    if (state.result && !state.result.isError && !VISIBLE_SUCCESS_TOOLS.has(state.toolName) && !hasImage) return [];
    return originalRender.call(this, width);
  };

  prototype.render = quietRender;
  return () => {
    if (prototype.render === quietRender) prototype.render = originalRender;
  };
}

/**
 * 隐藏空标签遗留的推理布局占位，并保留同一消息中的正常正文。
 */
export function installHiddenThinkingRendering(componentClass: AssistantMessageComponentClass): () => void {
  const prototype = componentClass.prototype;
  const originalRender = prototype.render;

  const quietRender = function (this: AssistantMessageComponentLike, width: number): string[] {
    const message = this.lastMessage;
    const hasHiddenThinking = message?.content.some((content) => content.type === "thinking");
    if (!message || !hasHiddenThinking) return originalRender.call(this, width);

    // 使用移除 thinking 后的临时组件重新布局，避免破坏正文内部有意义的空行。
    const visibleMessage = {
      ...message,
      content: message.content.filter((content) => content.type !== "thinking"),
    };
    const visibleComponent = new componentClass(
      visibleMessage,
      true,
      this.markdownTheme,
      "",
      this.outputPad,
      this.markdownTransformers,
    );
    visibleComponent.updateContent(visibleMessage, this.isStreaming);
    return originalRender.call(visibleComponent, width);
  };

  prototype.render = quietRender;
  return () => {
    if (prototype.render === quietRender) prototype.render = originalRender;
  };
}
