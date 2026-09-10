import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { marked } from "marked";

const execFileAsync = promisify(execFile);

const COPY_RICH_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

function run(argv) {
  const payloadPath = $(argv[0]).stringByStandardizingPath;
  const data = $.NSData.dataWithContentsOfFile(payloadPath);
  const payload = $.NSJSONSerialization.JSONObjectWithDataOptionsError(data, 0, null).js;
  const pasteboard = $.NSPasteboard.generalPasteboard;

  const rtf = $.NSData.alloc.initWithBase64EncodedStringOptions($(payload.rtf), 0);

  pasteboard.clearContents;
  const rtfWritten = pasteboard.setDataForType(rtf, $.NSPasteboardTypeRTF);
  const htmlWritten = pasteboard.setStringForType($(payload.html), $.NSPasteboardTypeHTML);
  const textWritten = pasteboard.setStringForType($(payload.plain), $.NSPasteboardTypeString);
  if (!rtfWritten || !htmlWritten || !textWritten) throw new Error("写入剪贴板失败");
}
`;

type SessionEntryLike = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

export type RichClipboardPayload = {
  plain: string;
  html: string;
};

export type AssistantMarkdownItem = {
  label: string;
  markdown: string;
};

/** 从会话条目中提取助手消息的 Markdown 文本。 */
function extractAssistantMarkdown(entry: SessionEntryLike): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "assistant") return undefined;
  if (!Array.isArray(entry.message.content)) return undefined;

  const text = entry.message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");

  return text || undefined;
}

/** 列出当前分支中的助手回复，并生成便于选择的唯一摘要。 */
export function listAssistantMarkdown(entries: readonly SessionEntryLike[]): AssistantMarkdownItem[] {
  const messages = entries
    .map(extractAssistantMarkdown)
    .filter((markdown): markdown is string => Boolean(markdown));

  return messages.map((markdown, index) => {
    const preview = markdown
      .replace(/^\s{0,3}#{1,6}\s+/u, "")
      .replace(/\s+/gu, " ")
      .trim();
    const summary = preview.length > 72 ? `${preview.slice(0, 72)}…` : preview;
    return {
      label: `[${index + 1}] ${summary}`,
      markdown,
    };
  });
}

/** 从当前分支倒序提取最后一条助手消息中的 Markdown 文本。 */
export function findLastAssistantMarkdown(entries: readonly SessionEntryLike[]): string | undefined {
  return listAssistantMarkdown(entries).at(-1)?.markdown;
}

/** 将 Markdown 转换为包含 HTML 与纯文本回退的剪贴板载荷。 */
export function createRichClipboardPayload(markdown: string): RichClipboardPayload {
  const fragment = marked
    .parse(markdown, {
      async: false,
      gfm: true,
    })
    // 明确表格边框和单元格间距，避免富文本编辑器将无样式表格降级为普通段落。
    .replace(/<table>/gu, '<table border="1" cellspacing="0" cellpadding="4">')
    .replace(/<th([^>]*)>/gu, '<th$1 style="border:1px solid #d0d7de;padding:4px 8px">')
    .replace(/<td([^>]*)>/gu, '<td$1 style="border:1px solid #d0d7de;padding:4px 8px">');

  return {
    plain: markdown,
    html: [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"></head><body>',
      "<!--StartFragment-->",
      fragment,
      "<!--EndFragment-->",
      "</body></html>",
    ].join(""),
  };
}

/** 将 HTML 转换为保留原生表格单元格结构的 RTF。 */
export async function createRichClipboardRtf(html: string): Promise<Buffer> {
  if (process.platform !== "darwin") {
    throw new Error("/copy-rich 当前仅支持 macOS");
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-copy-rich-rtf-"));
  const htmlPath = join(tempDirectory, "content.html");
  const rtfPath = join(tempDirectory, "content.rtf");

  try {
    await writeFile(htmlPath, html, "utf8");
    await execFileAsync("/usr/bin/textutil", [
      "-convert",
      "rtf",
      "-format",
      "html",
      "-output",
      rtfPath,
      htmlPath,
    ], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return await readFile(rtfPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** 通过 macOS NSPasteboard 同时写入 RTF、HTML 与纯文本剪贴板格式。 */
export async function copyRichTextToClipboard(payload: RichClipboardPayload): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("/copy-rich 当前仅支持 macOS");
  }

  const rtf = await createRichClipboardRtf(payload.html);
  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-copy-rich-"));
  const scriptPath = join(tempDirectory, "copy-rich.js");
  const payloadPath = join(tempDirectory, "payload.json");

  try {
    await Promise.all([
      writeFile(scriptPath, COPY_RICH_SCRIPT, "utf8"),
      writeFile(payloadPath, JSON.stringify({ ...payload, rtf: rtf.toString("base64") }), "utf8"),
    ]);
    await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", scriptPath, payloadPath], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
