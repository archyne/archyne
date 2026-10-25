import { describe, expect, it } from "vitest";
import { clampCrop, croppedSize, MIN_CROP } from "./crop";

const natural = { width: 300, height: 150 };

describe("clampCrop", () => {
  it("keeps the frame inside the picture", () => {
    expect(clampCrop({ x: -20, y: 140, width: 100, height: 50 }, natural)).toEqual({
      x: 0,
      y: 100,
      width: 100,
      height: 50,
    });
  });

  it("will not let a drag shrink it to nothing, nor past the picture", () => {
    const tiny = clampCrop({ x: 10, y: 10, width: 0, height: -5 }, natural);
    expect(tiny.width).toBe(MIN_CROP);
    expect(tiny.height).toBe(MIN_CROP);
    expect(clampCrop({ x: 0, y: 0, width: 999, height: 999 }, natural)).toEqual({
      x: 0,
      y: 0,
      ...natural,
    });
  });

  it("cuts on whole pixels", () => {
    expect(clampCrop({ x: 10.4, y: 2.6, width: 50.5, height: 20.2 }, natural)).toEqual({
      x: 10,
      y: 3,
      width: 51,
      height: 20,
    });
  });
});

describe("croppedSize", () => {
  it("leaves the part kept the size it was drawn at", () => {
    // Drawn at 240×120, a 300×150 picture is at 0.8; its right half stays at 0.8.
    expect(
      croppedSize({ width: 240, height: 120 }, natural, {
        x: 150,
        y: 0,
        width: 150,
        height: 150,
      }),
    ).toEqual({ width: 120, height: 120 });
  });
});
