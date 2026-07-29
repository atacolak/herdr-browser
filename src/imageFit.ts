import type { PaneGraphicsPlacement } from "./herdrGraphics";

export type ContentArea = {
  /** Available grid width in cells. */
  columns: number;
  /** Available grid height in cells. */
  rows: number;
  /** Pixel width of one terminal cell. */
  cellWidthPx: number;
  /** Pixel height of one terminal cell. */
  cellHeightPx: number;
  /** 0-based column origin of the content area within the pane. */
  originCol?: number;
  /** 0-based row origin of the content area within the pane. */
  originRow?: number;
};

export type ImagePixels = {
  width: number;
  height: number;
};

/**
 * Choose a cell-grid placement that contains the full image inside the content
 * area, maximizes covered area, and preserves the image aspect ratio.
 *
 * The terminal/graphics layer stretches the bitmap to the placement rectangle,
 * so the rectangle's pixel aspect (cells × cell pixels) must match the image.
 */
export function containFitPlacement(
  content: ContentArea,
  image: ImagePixels,
): PaneGraphicsPlacement {
  const originCol = Math.max(0, Math.floor(content.originCol ?? 0));
  const originRow = Math.max(0, Math.floor(content.originRow ?? 0));
  const columns = Math.max(1, Math.floor(content.columns));
  const rows = Math.max(1, Math.floor(content.rows));
  const cellWidthPx = positive(content.cellWidthPx) ?? 1;
  const cellHeightPx = positive(content.cellHeightPx) ?? 1;
  const imageWidth = positive(image.width);
  const imageHeight = positive(image.height);

  if (!imageWidth || !imageHeight) {
    return {
      viewportCol: originCol,
      viewportRow: originRow,
      gridCols: columns,
      gridRows: rows,
    };
  }

  const areaWidthPx = columns * cellWidthPx;
  const areaHeightPx = rows * cellHeightPx;
  const scale = Math.min(areaWidthPx / imageWidth, areaHeightPx / imageHeight);
  const fittedWidthPx = imageWidth * scale;
  const fittedHeightPx = imageHeight * scale;

  // Prefer independent rounding of the ideal pixel box, then repair aspect if
  // the integer grid drifts too far or overflows the content area.
  let gridCols = clamp(Math.round(fittedWidthPx / cellWidthPx), 1, columns);
  let gridRows = clamp(Math.round(fittedHeightPx / cellHeightPx), 1, rows);

  const imageAspect = imageWidth / imageHeight;
  const gridAspect = (gridCols * cellWidthPx) / (gridRows * cellHeightPx);
  const aspectError = Math.abs(gridAspect - imageAspect) / imageAspect;
  if (aspectError > 0.02) {
    // Re-derive the minor axis from the major axis so the cell box matches the
    // image aspect as closely as integer cells allow.
    if (fittedWidthPx / areaWidthPx >= fittedHeightPx / areaHeightPx) {
      gridCols = columns;
      gridRows = clamp(
        Math.round((gridCols * cellWidthPx) / (imageAspect * cellHeightPx)),
        1,
        rows,
      );
      gridCols = clamp(
        Math.round((gridRows * cellHeightPx * imageAspect) / cellWidthPx),
        1,
        columns,
      );
    } else {
      gridRows = rows;
      gridCols = clamp(
        Math.round((gridRows * cellHeightPx * imageAspect) / cellWidthPx),
        1,
        columns,
      );
      gridRows = clamp(
        Math.round((gridCols * cellWidthPx) / (imageAspect * cellHeightPx)),
        1,
        rows,
      );
    }
  }

  const viewportCol = originCol + Math.floor((columns - gridCols) / 2);
  const viewportRow = originRow + Math.floor((rows - gridRows) / 2);
  return {
    viewportCol,
    viewportRow,
    gridCols,
    gridRows,
  };
}

/**
 * Pick the best available intrinsic image size for contain-fit.
 * Prefer a real frame; fall back to the logical viewport raster.
 */
export function resolveFitImageSize(options: {
  frame?: ImagePixels | null;
  raster?: ImagePixels | null;
  fallbackAspect?: number;
  content: ContentArea;
}): ImagePixels {
  if (options.frame && positive(options.frame.width) && positive(options.frame.height)) {
    return {
      width: Math.round(options.frame.width),
      height: Math.round(options.frame.height),
    };
  }
  if (options.raster && positive(options.raster.width) && positive(options.raster.height)) {
    return {
      width: Math.round(options.raster.width),
      height: Math.round(options.raster.height),
    };
  }
  const aspect = positive(options.fallbackAspect) ?? 16 / 9;
  const areaWidthPx = Math.max(1, options.content.columns) * (positive(options.content.cellWidthPx) ?? 1);
  const areaHeightPx = Math.max(1, options.content.rows) * (positive(options.content.cellHeightPx) ?? 1);
  // Synthetic size used only to establish aspect before the first frame.
  if (areaWidthPx / areaHeightPx > aspect) {
    return {
      width: Math.max(1, Math.round(areaHeightPx * aspect)),
      height: Math.max(1, Math.round(areaHeightPx)),
    };
  }
  return {
    width: Math.max(1, Math.round(areaWidthPx)),
    height: Math.max(1, Math.round(areaWidthPx / aspect)),
  };
}

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
