interface UserMessageComponentLike {
  text: string;
  rebuild(): void;
}

interface UserMessageComponentClass {
  prototype: UserMessageComponentLike;
}

type LabelFormatter = () => string;

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
