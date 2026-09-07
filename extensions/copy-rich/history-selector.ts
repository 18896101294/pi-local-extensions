import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { AssistantMarkdownItem } from "./core.ts";
import {
  createHistorySelectionState,
  getHistoryPage,
  navigateHistorySelection,
  type HistoryNavigation,
  type HistorySelectionState,
} from "./history-pagination.ts";

export class HistorySelector implements Component {
  private state: HistorySelectionState;

  /** 创建默认定位到最新回复的分页选择器。 */
  constructor(
    private readonly messages: readonly AssistantMarkdownItem[],
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly onSelect: (markdown: string) => void,
    private readonly onCancel: () => void,
    private readonly onChange: () => void,
  ) {
    this.state = createHistorySelectionState(messages.length);
  }

  /** 响应选择、翻页、确认和取消按键。 */
  handleInput(data: string): void {
    let navigation: HistoryNavigation | undefined;
    if (this.keybindings.matches(data, "tui.select.up")) navigation = "up";
    else if (this.keybindings.matches(data, "tui.select.down")) navigation = "down";
    else if (matchesKey(data, Key.left)) navigation = "previousPage";
    else if (matchesKey(data, Key.right)) navigation = "nextPage";
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.messages[this.state.selectedIndex];
      if (selected) this.onSelect(selected.markdown);
      return;
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }

    if (!navigation) return;
    this.state = navigateHistorySelection(this.state, navigation, this.messages.length);
    this.onChange();
  }

  /** 渲染当前页、选中项和快捷键提示。 */
  render(width: number): string[] {
    if (width <= 0) return [];

    const page = getHistoryPage(this.state, this.messages.length);
    const lines = [
      this.theme.fg("border", "─".repeat(width)),
      this.theme.fg("accent", this.theme.bold(" 选择要复制的助手回复")),
      this.theme.fg(
        "dim",
        ` 第 ${page.pageIndex + 1}/${page.pageCount} 页 · 共 ${this.messages.length} 条`,
      ),
      "",
    ];

    for (let index = page.startIndex; index < page.endIndex; index += 1) {
      const message = this.messages[index];
      const selected = index === this.state.selectedIndex;
      const prefix = selected ? " › " : "   ";
      const text = selected
        ? this.theme.fg("accent", this.theme.bold(`${prefix}${message.label}`))
        : `${prefix}${message.label}`;
      lines.push(text);
    }

    lines.push(
      "",
      this.theme.fg("dim", " ←/→ 翻页 · ↑/↓ 选择 · Enter 复制 · Esc 取消"),
      this.theme.fg("border", "─".repeat(width)),
    );

    return lines.map((line) => truncateToWidth(line, width));
  }

  /** 当前组件不缓存渲染结果，无需额外失效处理。 */
  invalidate(): void {}
}
