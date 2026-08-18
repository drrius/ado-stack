const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
];

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function inRanges(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) {
    return 0;
  }
  if (inRanges(codePoint, WIDE_RANGES)) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    width += codePointWidth(codePoint);
  }
  return width;
}

export function ellipsizeToWidth(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (displayWidth(text) <= width) {
    return text;
  }
  if (width === 1) {
    return "…";
  }
  const budget = width - 1;
  let out = "";
  let used = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const next = used + codePointWidth(codePoint);
    if (next > budget) {
      break;
    }
    out += char;
    used = next;
  }
  return `${out}…`;
}
