import { expect, test } from "bun:test";

import { pageRows, renderToolbar, sameStreamParams, toolbarActionsFromMouseEvents } from "./viewer";

const tabs = [
  { targetId: "one", title: "First", url: "https://one.test", active: true },
  { targetId: "two", title: "Second", url: "https://two.test", active: false },
];

test("browser toolbar renders tabs above navigation and URL controls", () => {
  const toolbar = renderToolbar({
    columns: 100,
    url: "https://one.test",
    input: { focused: false, value: "", selectedAll: false },
    tabs,
  });
  const [tabRow, controlRow] = toolbar.text.split("\r\n");

  expect(tabRow).toContain("[1* First][x]");
  expect(tabRow).toContain("[2 Second][x]");
  expect(tabRow).toContain("[+]");
  expect(controlRow).toContain("[<] [>] [R] [Stop] [-] [+] https://one.test");
  expect(tabRow).toHaveLength(100);
  expect(controlRow).toHaveLength(100);
});

test("browser toolbar routes clicks by row", () => {
  const toolbar = renderToolbar({
    columns: 100,
    url: "https://one.test",
    input: { focused: false, value: "", selectedAll: false },
    tabs,
  });
  const release = (column: number, row: number) => ({
    button: 0,
    column,
    row,
    released: true,
  });
  const newTab = toolbar.layout.actions.find((item) => item.action.kind === "new-tab");
  const closeTab = toolbar.layout.actions.find((item) => item.action.kind === "close-tab");

  expect(toolbarActionsFromMouseEvents([
    release(newTab!.startColumn, 1),
    release(closeTab!.startColumn, 1),
    release(toolbar.layout.urlStartColumn, 2),
  ], toolbar.layout)).toEqual([
    { kind: "new-tab" },
    { kind: "close-tab", targetId: "one" },
    { kind: "focus-url" },
  ]);
});

test("browser toolbar keeps an overflowing active tab actionable", () => {
  const manyTabs = Array.from({ length: 8 }, (_, index) => ({
    targetId: `tab-${index}`,
    title: `Tab ${index}`,
    url: `https://${index}.test`,
    active: index === 7,
  }));
  const toolbar = renderToolbar({
    columns: 50,
    url: "https://7.test",
    input: { focused: false, value: "", selectedAll: false },
    tabs: manyTabs,
  });

  expect(toolbar.layout.actions).toContainEqual(expect.objectContaining({
    action: { kind: "switch-tab", targetId: "tab-7" },
  }));
  expect(toolbar.layout.actions).toContainEqual(expect.objectContaining({
    action: { kind: "close-tab", targetId: "tab-7" },
  }));
});

test("page rows reserve only browser chrome and enabled diagnostics", () => {
  expect(pageRows(24, false)).toBe(22);
  expect(pageRows(24, true)).toBe(21);
});

test("observe mirror toolbar labels the pane as OBSERVE without actions", () => {
  const toolbar = renderToolbar({
    columns: 80,
    url: "https://one.test",
    input: { focused: false, value: "", selectedAll: false },
    tabs,
    observeMirror: true,
  });
  const [tabRow, controlRow] = toolbar.text.split("\r\n");
  expect(tabRow).toContain("[OBSERVE]");
  expect(controlRow).toContain("read-only mirror");
  expect(toolbar.layout.actions).toEqual([]);
  expect(tabRow).toHaveLength(80);
  expect(controlRow).toHaveLength(80);
});

test("sameStreamParams requires prior params to skip a re-POST", () => {
  const placement = { viewportCol: 0, viewportRow: 2, gridCols: 100, gridRows: 40 };
  const capture = { maxWidth: 800, maxHeight: 600 };
  expect(sameStreamParams(null, placement, capture)).toBe(false);
});

test("sameStreamParams matches identical placement and capture", () => {
  const placement = { viewportCol: 0, viewportRow: 2, gridCols: 100, gridRows: 40 };
  const capture = { maxWidth: 800, maxHeight: 600 };
  expect(sameStreamParams({ placement, capture }, { ...placement }, { ...capture })).toBe(true);
  expect(sameStreamParams({ placement, capture: null }, { ...placement }, null)).toBe(true);
});

test("sameStreamParams detects a placement or capture change", () => {
  const placement = { viewportCol: 0, viewportRow: 2, gridCols: 100, gridRows: 40 };
  const capture = { maxWidth: 800, maxHeight: 600 };
  expect(sameStreamParams({ placement, capture }, { ...placement, gridCols: 101 }, capture)).toBe(false);
  expect(sameStreamParams({ placement, capture }, placement, { maxWidth: 801, maxHeight: 600 })).toBe(false);
  expect(sameStreamParams({ placement, capture }, placement, null)).toBe(false);
});
