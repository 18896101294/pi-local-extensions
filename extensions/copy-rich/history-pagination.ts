export const HISTORY_PAGE_SIZE = 10;

export type HistorySelectionState = {
  selectedIndex: number;
};

export type HistoryNavigation = "up" | "down" | "previousPage" | "nextPage";

export type HistoryPage = {
  pageIndex: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
};

/** 将数字限制在指定闭区间内。 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** 创建默认定位到最新回复的历史选择状态。 */
export function createHistorySelectionState(itemCount: number): HistorySelectionState {
  return { selectedIndex: Math.max(0, itemCount - 1) };
}

/** 计算当前选择项所在页及该页的数据边界。 */
export function getHistoryPage(
  state: HistorySelectionState,
  itemCount: number,
  pageSize = HISTORY_PAGE_SIZE,
): HistoryPage {
  const pageCount = Math.max(1, Math.ceil(itemCount / pageSize));
  const selectedIndex = clamp(state.selectedIndex, 0, Math.max(0, itemCount - 1));
  const pageIndex = Math.floor(selectedIndex / pageSize);
  const startIndex = pageIndex * pageSize;

  return {
    pageIndex,
    pageCount,
    startIndex,
    endIndex: Math.min(startIndex + pageSize, itemCount),
  };
}

/** 根据方向键更新历史回复的选择位置。 */
export function navigateHistorySelection(
  state: HistorySelectionState,
  navigation: HistoryNavigation,
  itemCount: number,
  pageSize = HISTORY_PAGE_SIZE,
): HistorySelectionState {
  if (itemCount === 0) return state;

  const page = getHistoryPage(state, itemCount, pageSize);
  if (navigation === "up") {
    return {
      selectedIndex:
        state.selectedIndex === page.startIndex ? page.endIndex - 1 : state.selectedIndex - 1,
    };
  }
  if (navigation === "down") {
    return {
      selectedIndex:
        state.selectedIndex === page.endIndex - 1 ? page.startIndex : state.selectedIndex + 1,
    };
  }

  const pageOffset = navigation === "previousPage" ? -1 : 1;
  const targetPageIndex = clamp(page.pageIndex + pageOffset, 0, page.pageCount - 1);
  const rowIndex = state.selectedIndex - page.startIndex;
  const targetStartIndex = targetPageIndex * pageSize;
  const targetEndIndex = Math.min(targetStartIndex + pageSize, itemCount);

  return {
    selectedIndex: Math.min(targetStartIndex + rowIndex, targetEndIndex - 1),
  };
}
