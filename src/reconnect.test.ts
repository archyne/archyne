import { describe, expect, it } from "vitest";
import {
  cornersAfterMove,
  isPin,
  nearestFace,
  nearestPin,
  PIN_STUB,
  pinFor,
} from "./reconnect";
import type { Box } from "./boxes";

const a: Box = { x: 0, y: 0, w: 100, h: 50 };
const b: Box = { x: 300, y: 0, w: 100, h: 50 };

describe("nearestPin", () => {
  const boxes = new Map([
    ["a", a],
    ["b", b],
  ]);

  it("takes the connection point within reach, on whichever box it is", () => {
    expect(nearestPin({ x: 104, y: 22 }, boxes, 38, 14)).toEqual({ node: "a", side: "right" });
    expect(nearestPin({ x: 350, y: -10 }, boxes, 38, 14)).toEqual({ node: "b", side: "top" });
  });

  it("takes aiming at the point from inside its box", () => {
    // The middle of a 100×50 box is 25 from its top and bottom points.
    expect(nearestPin({ x: 50, y: 25 }, boxes, 38, 14)).toBeNull();
    expect(nearestPin({ x: 50, y: 8 }, boxes, 38, 14)).toEqual({ node: "a", side: "top" });
  });

  it("is none when no connection point is within reach", () => {
    // Inside a box, but far from the middle of every face.
    const big = new Map([["c", { x: 0, y: 0, w: 200, h: 200 }]]);
    expect(nearestPin({ x: 5, y: 5 }, big, 38, 14)).toBeNull();
  });
});

describe("nearestFace", () => {
  it("answers the face the point is closest to", () => {
    expect(nearestFace({ x: 95, y: 25 }, a)).toBe("right");
    expect(nearestFace({ x: 50, y: 48 }, a)).toBe("bottom");
  });
});

describe("isPin", () => {
  it("recognises the corner that pins an end", () => {
    for (const side of ["left", "right", "top", "bottom"] as const) {
      expect(isPin(pinFor(a, side), a)).toBe(true);
    }
  });

  it("does not take a corner further out, or off the face, for one", () => {
    expect(isPin({ x: 100 + PIN_STUB * 3, y: 25 }, a)).toBe(false);
    expect(isPin({ x: 110, y: -10 }, a)).toBe(false);
    expect(isPin({ x: 50, y: 25 }, a)).toBe(false);
  });
});

describe("cornersAfterMove", () => {
  const middle = [
    { x: 200, y: -80 },
    { x: 250, y: -80 },
  ];

  it("drops the corners in between, which led to where the end was", () => {
    expect(cornersAfterMove(middle, "target", a, b, null)).toEqual([]);
  });

  it("pins the moved end when it was let go on a connection point", () => {
    expect(cornersAfterMove(middle, "target", a, b, "top")).toEqual([pinFor(b, "top")]);
    expect(cornersAfterMove(middle, "source", b, a, "bottom")).toEqual([pinFor(a, "bottom")]);
  });

  it("keeps the pin of the end that stayed put", () => {
    const pinned = [pinFor(a, "bottom"), ...middle];
    expect(cornersAfterMove(pinned, "target", a, b, "left")).toEqual([
      pinFor(a, "bottom"),
      pinFor(b, "left"),
    ]);
    const atTarget = [...middle, pinFor(b, "top")];
    expect(cornersAfterMove(atTarget, "source", b, a, null)).toEqual([pinFor(b, "top")]);
  });
});
