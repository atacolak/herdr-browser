import { expect, test } from "bun:test";

import { containFitPlacement, resolveFitImageSize } from "./imageFit";

test("containFitPlacement fills the content area when aspects match", () => {
  // 100x40 cells × 10x20 px = 1000x800 content; 1000x800 image → full grid.
  const placement = containFitPlacement(
    {
      columns: 100,
      rows: 40,
      cellWidthPx: 10,
      cellHeightPx: 20,
      originCol: 0,
      originRow: 2,
    },
    { width: 1000, height: 800 },
  );
  expect(placement).toEqual({
    viewportCol: 0,
    viewportRow: 2,
    gridCols: 100,
    gridRows: 40,
  });
});

test("containFitPlacement letterboxes a 16:9 frame in a taller content area", () => {
  // Content pixels: 120 cols × 10px = 1200 wide, 50 rows × 20px = 1000 tall (1.2:1).
  // 16:9 (~1.78) is wider than the content box → width-limited letterbox
  // (full width, reduced height).
  const placement = containFitPlacement(
    {
      columns: 120,
      rows: 50,
      cellWidthPx: 10,
      cellHeightPx: 20,
      originCol: 0,
      originRow: 2,
    },
    { width: 1920, height: 1080 },
  );

  expect(placement.gridCols).toBe(120);
  expect(placement.gridRows).toBeLessThan(50);
  expect(placement.viewportCol).toBe(0);
  expect(placement.viewportRow).toBeGreaterThan(2);
  expect(placement.viewportRow + placement.gridRows).toBeLessThanOrEqual(52);

  const boxAspect =
    (placement.gridCols * 10) / (placement.gridRows * 20);
  expect(boxAspect).toBeCloseTo(16 / 9, 1);
});

test("containFitPlacement pillarboxes a 16:9 frame in a wider content area", () => {
  // Wide short pane: 160x20 cells × 10x20 = 1600x400 (4:1).
  // 16:9 (~1.78) is narrower than the content box → height-limited pillarbox
  // (full height, reduced width).
  const placement = containFitPlacement(
    {
      columns: 160,
      rows: 20,
      cellWidthPx: 10,
      cellHeightPx: 20,
      originCol: 0,
      originRow: 2,
    },
    { width: 1920, height: 1080 },
  );

  expect(placement.gridRows).toBe(20);
  expect(placement.gridCols).toBeLessThan(160);
  expect(placement.viewportRow).toBe(2);
  expect(placement.viewportCol).toBeGreaterThan(0);
  expect(placement.viewportCol + placement.gridCols).toBeLessThanOrEqual(160);

  const boxAspect =
    (placement.gridCols * 10) / (placement.gridRows * 20);
  expect(boxAspect).toBeCloseTo(16 / 9, 1);
});

test("containFitPlacement never exceeds the content area", () => {
  const content = {
    columns: 89,
    rows: 44,
    cellWidthPx: 9,
    cellHeightPx: 18,
    originCol: 0,
    originRow: 2,
  };
  const placement = containFitPlacement(content, { width: 1280, height: 720 });
  expect(placement.gridCols).toBeGreaterThanOrEqual(1);
  expect(placement.gridRows).toBeGreaterThanOrEqual(1);
  expect(placement.gridCols).toBeLessThanOrEqual(content.columns);
  expect(placement.gridRows).toBeLessThanOrEqual(content.rows);
  expect(placement.viewportCol).toBeGreaterThanOrEqual(content.originCol);
  expect(placement.viewportRow).toBeGreaterThanOrEqual(content.originRow);
  expect(placement.viewportCol + placement.gridCols).toBeLessThanOrEqual(
    content.originCol + content.columns,
  );
  expect(placement.viewportRow + placement.gridRows).toBeLessThanOrEqual(
    content.originRow + content.rows,
  );
});

test("containFitPlacement maximizes area for a square image in a wide pane", () => {
  // 200x20 cells × 10x20 = 2000x400. Square image → height limited, 400x400 → 40x20 cells.
  const placement = containFitPlacement(
    {
      columns: 200,
      rows: 20,
      cellWidthPx: 10,
      cellHeightPx: 20,
      originCol: 0,
      originRow: 0,
    },
    { width: 800, height: 800 },
  );
  expect(placement.gridRows).toBe(20);
  expect(placement.gridCols).toBe(40);
  expect(placement.viewportCol).toBe(80);
  expect(placement.viewportRow).toBe(0);
});

test("resolveFitImageSize prefers frame pixels over raster fallback", () => {
  const content = {
    columns: 100,
    rows: 40,
    cellWidthPx: 10,
    cellHeightPx: 20,
  };
  expect(resolveFitImageSize({
    frame: { width: 1920, height: 1080 },
    raster: { width: 1000, height: 800 },
    content,
  })).toEqual({ width: 1920, height: 1080 });
});

test("resolveFitImageSize falls back to raster then 16:9 synthetic", () => {
  const content = {
    columns: 100,
    rows: 40,
    cellWidthPx: 10,
    cellHeightPx: 20,
  };
  expect(resolveFitImageSize({
    frame: null,
    raster: { width: 1000, height: 800 },
    content,
  })).toEqual({ width: 1000, height: 800 });

  const synthetic = resolveFitImageSize({
    frame: null,
    raster: null,
    fallbackAspect: 16 / 9,
    content,
  });
  expect(synthetic.width / synthetic.height).toBeCloseTo(16 / 9, 2);
});
