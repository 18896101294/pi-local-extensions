import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface UserMessageComponentLike {
  text: string;
  rebuild(): void;
}

interface UserMessageComponentClass {
  prototype: UserMessageComponentLike;
}

interface EditorComponentLike {
  focused: boolean;
  getPaddingX(): number;
  getText(): string;
  render(width: number): string[];
}

interface EditorComponentClass {
  prototype: EditorComponentLike;
}

type LabelFormatter = () => string;
type TextFormatter = (text: string) => string;

/**
 * 为用户消息渲染增加单行身份前缀，同时保持原始消息内容不变。
 */
export function installUserMessagePrefix(
  componentClass: UserMessageComponentClass,
  formatLabel: LabelFormatter,
): () => void {
  const prototype = componentClass.prototype;
  const originalRebuild = prototype.rebuild;

  const enhancedRebuild = function (this: UserMessageComponentLike): void {
    const originalText = this.text;
    this.text = `${formatLabel()}${originalText}`;
    try {
      originalRebuild.call(this);
    } finally {
      this.text = originalText;
    }
  };

  prototype.rebuild = enhancedRebuild;
  return () => {
    if (prototype.rebuild === enhancedRebuild) prototype.rebuild = originalRebuild;
  };
}

/**
 * 为编辑器空输入状态增加占位提示，同时保持编辑器真实内容为空。
 */
export function installEditorPlaceholder(
  componentClass: EditorComponentClass,
  placeholder: string,
  formatPlaceholder: TextFormatter,
): () => void {
  const prototype = componentClass.prototype;
  const originalRender = prototype.render;

  /** 在编辑器为空时，用占位提示替换原始空白输入行。 */
  const enhancedRender = function (this: EditorComponentLike, width: number): string[] {
    const lines = originalRender.call(this, width);
    if (this.getText() !== "" || lines.length < 3) return lines;

    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const paddingX = Math.min(this.getPaddingX(), maxPadding);
    const contentWidth = Math.max(1, width - paddingX * 2);
    const visiblePlaceholder = truncateToWidth(placeholder, contentWidth, "");
    const [firstCharacter = "", ...remainingCharacters] = [...visiblePlaceholder];
    if (!firstCharacter) return lines;

    const marker = this.focused ? CURSOR_MARKER : "";
    const cursor = `\x1b[7m${formatPlaceholder(firstCharacter)}\x1b[27m`;
    const remainder = formatPlaceholder(remainingCharacters.join(""));
    const linePadding = " ".repeat(
      Math.max(0, contentWidth - visibleWidth(visiblePlaceholder)),
    );
    const sidePadding = " ".repeat(paddingX);
    lines[1] = `${sidePadding}${marker}${cursor}${remainder}${linePadding}${sidePadding}`;
    return lines;
  };

  prototype.render = enhancedRender;
  return () => {
    if (prototype.render === enhancedRender) prototype.render = originalRender;
  };
}
