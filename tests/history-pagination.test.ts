import assert from "node:assert/strict";
import test from "node:test";
import {
  createHistorySelectionState,
  getHistoryPage,
  navigateHistorySelection,
} from "../extensions/copy-rich/history-pagination.ts";

test("历史选择器默认定位到最新一页的最新回复", () => {
  const state = createHistorySelectionState(23);

  assert.deepEqual(state, { selectedIndex: 22 });
  assert.deepEqual(getHistoryPage(state, 23), {
    pageIndex: 2,
    pageCount: 3,
    startIndex: 20,
    endIndex: 23,
  });
});

test("左右翻页保留当前行，并在不足一页时收敛到末项", () => {
  let state = createHistorySelectionState(23);

  state = navigateHistorySelection(state, "previousPage", 23);
  assert.equal(state.selectedIndex, 12);
  state = navigateHistorySelection(state, "previousPage", 23);
  assert.equal(state.selectedIndex, 2);
  state = navigateHistorySelection(state, "nextPage", 23);
  assert.equal(state.selectedIndex, 12);
  state = navigateHistorySelection(state, "nextPage", 23);
  assert.equal(state.selectedIndex, 22);
});

test("上下方向键只在当前页内循环选择", () => {
  let state = { selectedIndex: 20 };

  state = navigateHistorySelection(state, "up", 23);
  assert.equal(state.selectedIndex, 22);
  state = navigateHistorySelection(state, "down", 23);
  assert.equal(state.selectedIndex, 20);
});
