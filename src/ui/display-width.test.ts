import { describe, expect, test } from "bun:test";
import { displayWidth, ellipsizeToWidth } from "./display-width.ts";

describe("displayWidth", () => {
  test("counts ASCII as one column", () => {
    expect(displayWidth("status")).toBe(6);
    expect(displayWidth("├── ")).toBe(4);
  });

  test("counts CJK as two columns and combining marks as zero", () => {
    expect(displayWidth("修复")).toBe(4);
    expect(displayWidth("e\u0301")).toBe(1);
  });
});

describe("ellipsizeToWidth", () => {
  test("cuts on terminal columns, not UTF-16 units", () => {
    expect(ellipsizeToWidth("修复编辑器", 5)).toBe("修复…");
    expect(displayWidth(ellipsizeToWidth("修复编辑器", 5))).toBeLessThanOrEqual(5);
  });
});
