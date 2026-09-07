import assert from "node:assert/strict";
import test from "node:test";
import {
  createRichClipboardPayload,
  findLastAssistantMarkdown,
  listAssistantMarkdown,
} from "../extensions/copy-rich/core.ts";

test("提取当前分支最后一条助手回复，并忽略思考与工具调用", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "旧回复" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "内部思考" },
          { type: "text", text: "## 新回复" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          { type: "text", text: "- 第一项" },
        ],
      },
    },
  ];

  assert.equal(findLastAssistantMarkdown(entries), "## 新回复\n\n- 第一项");
});

test("列出当前分支的历史助手回复并生成唯一摘要", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "## 第一条\n\n内容" }],
      },
    },
    {
      type: "message",
      message: { role: "user", content: "继续" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第二条很长的回复" }],
      },
    },
  ];

  assert.deepEqual(listAssistantMarkdown(entries), [
    { label: "[1] 第一条 内容", markdown: "## 第一条\n\n内容" },
    { label: "[2] 第二条很长的回复", markdown: "第二条很长的回复" },
  ]);
});

test("将 Markdown 转为飞书可读取的 HTML，同时保留纯文本回退", () => {
  const markdown = "## 标题\n\n- **重点**\n\n| A | B |\n|---|---|\n| 1 | 2 |";
  const payload = createRichClipboardPayload(markdown);

  assert.equal(payload.plain, markdown);
  assert.match(payload.html, /<h2>标题<\/h2>/);
  assert.match(payload.html, /<li><strong>重点<\/strong><\/li>/);
  assert.match(payload.html, /<table>/);
  assert.match(payload.html, /<!--StartFragment-->/);
  assert.match(payload.html, /<!--EndFragment-->/);
});
