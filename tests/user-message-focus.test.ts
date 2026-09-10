import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installEditorPlaceholder } from "../extensions/user-message-focus/rendering.ts";

class MockEditor {
  focused = false;
  private text: string;

  /** 创建指定内容的编辑器测试替身。 */
  constructor(text: string) {
    this.text = text;
  }

  /** 返回测试用的水平内边距。 */
  getPaddingX(): number {
    return 0;
  }

  /** 返回测试用的编辑器内容。 */
  getText(): string {
    return this.text;
  }

  /** 渲染未增强时的编辑器边框和输入行。 */
  render(width: number): string[] {
    return ["─".repeat(width), " ".repeat(width), "─".repeat(width)];
  }
}

test("仅在编辑器为空时显示默认提示且不改变真实内容", () => {
  const originalRender = MockEditor.prototype.render;
  const restore = installEditorPlaceholder(
    MockEditor,
    "佛祖保佑，永无 BUG ！",
    (text) => text,
  );

  const emptyEditor = new MockEditor("");
  const emptyLines = emptyEditor.render(30);
  assert.match(stripVTControlCharacters(emptyLines[1]!), /佛祖保佑，永无 BUG ！/);
  assert.equal(visibleWidth(emptyLines[1]!), 30);
  assert.equal(emptyEditor.getText(), "");

  const populatedEditor = new MockEditor("已有输入");
  assert.doesNotMatch(populatedEditor.render(30)[1]!, /佛祖保佑/);

  restore();
  assert.equal(MockEditor.prototype.render, originalRender);
});
