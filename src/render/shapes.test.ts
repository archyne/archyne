import { describe, expect, it } from "vitest";
import { outlineDepth, pointsAttr, shapeGeometry, type Primitive } from "./shapes";
import { SHAPES } from "../model/types";

/**
 * The geometry every drawer shares.
 *
 * These used to be a `switch` returning JSX, checked only by looking at the
 * canvas. Now two things draw from it — the canvas and the SVG renderer — so
 * the properties that hold across all fourteen shapes are worth stating rather
 * than re-discovering in whichever of the two happens to look wrong.
 */

/** Every coordinate a primitive touches, for the bounds it occupies. */
function extent(ps: Primitive[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of ps) {
    switch (p.kind) {
      case "rect":
        xs.push(p.x, p.x + p.width);
        ys.push(p.y, p.y + p.height);
        break;
      case "ellipse":
        xs.push(p.cx - p.rx, p.cx + p.rx);
        ys.push(p.cy - p.ry, p.cy + p.ry);
        break;
      case "polygon":
        for (const [x, y] of p.points) {
          xs.push(x);
          ys.push(y);
        }
        break;
      case "line":
        xs.push(p.x1, p.x2);
        ys.push(p.y1, p.y2);
        break;
      case "path":
        // Arcs are not worth parsing to bound; the cylinder has its own case.
        break;
    }
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe("every shape", () => {
  it("draws something", () => {
    for (const shape of SHAPES) {
      expect(shapeGeometry(shape, 160, 54).length, shape).toBeGreaterThan(0);
    }
  });

  it("has exactly one body to take the node's colours", () => {
    // `.shape-fill` is what a `style fill:#f9f` paints. Two of them would paint
    // twice and read as a darker node; none would leave a custom colour with
    // nothing to land on.
    for (const shape of SHAPES) {
      const fills = shapeGeometry(shape, 160, 54).filter((p) => p.paint === "fill");
      expect(fills.length, shape).toBe(1);
    }
  });

  it("stays inside the box, inset by the stroke", () => {
    // The 1px inset is why: a stroke straddles its path, so a shape drawn flush
    // to the edge loses half of it to the element's own boundary.
    for (const shape of SHAPES) {
      if (shape === "cylinder") continue; // arcs, bounded in its own case below
      const box = extent(shapeGeometry(shape, 160, 54));
      expect(box.minX, shape).toBeGreaterThanOrEqual(1);
      expect(box.minY, shape).toBeGreaterThanOrEqual(1);
      expect(box.maxX, shape).toBeLessThanOrEqual(159);
      expect(box.maxY, shape).toBeLessThanOrEqual(53);
    }
  });

  it("scales with the box it is given", () => {
    for (const shape of SHAPES) {
      const small = extent(shapeGeometry(shape, 100, 40));
      const large = extent(shapeGeometry(shape, 300, 120));
      if (shape === "cylinder") continue;
      expect(large.maxX, shape).toBeGreaterThan(small.maxX);
    }
  });
});

describe("the shapes with something particular about them", () => {
  it("rounds a stadium to a half-height, so its ends are semicircles", () => {
    const [body] = shapeGeometry("stadium", 160, 54);
    expect(body).toMatchObject({ kind: "rect", rx: 26 });
  });

  it("gives a subroutine its two inner bars", () => {
    const bars = shapeGeometry("subroutine", 160, 54).filter((p) => p.kind === "line");
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => (b.kind === "line" ? b.x1 : 0))).toEqual([9, 151]);
  });

  it("draws a double circle's inner ring inside the outer one", () => {
    const [outer, inner] = shapeGeometry("doublecircle", 96, 96);
    expect(outer.kind === "ellipse" && inner.kind === "ellipse").toBe(true);
    if (outer.kind !== "ellipse" || inner.kind !== "ellipse") return;
    expect(inner.rx).toBeLessThan(outer.rx);
    expect(inner.paint).toBe("line");
  });

  it("gives a cylinder a barrel and a rim over it", () => {
    const ps = shapeGeometry("cylinder", 160, 54);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ kind: "path", paint: "fill" });
    expect(ps[1]).toMatchObject({ kind: "path", paint: "line" });
  });

  it("keeps a short wide hexagon from collapsing into a diamond", () => {
    // The corner cut is 18% of the width, but capped at half the height —
    // without the cap a 300×20 hexagon has its cuts meeting in the middle.
    const [wide] = shapeGeometry("hexagon", 300, 20);
    if (wide.kind !== "polygon") throw new Error("hexagon is a polygon");
    const cut = wide.points[0][0];
    expect(cut).toBe(10);
    expect(cut * 2).toBeLessThanOrEqual(300);
  });

  it("puts the point of a diamond on each side's middle", () => {
    const [d] = shapeGeometry("diamond", 150, 86);
    expect(d.kind === "polygon" && d.points).toEqual([
      [75, 1],
      [149, 43],
      [75, 85],
      [1, 43],
    ]);
  });
});

describe("a shape this build does not know", () => {
  it("comes out as a plain box rather than as nothing", () => {
    // `data.shape` is parsed out of a file, so it can name something this
    // build has never heard of. Falling out of the switch returned
    // `undefined`, and the renderer took the whole diagram down on it.
    const ps = shapeGeometry("teapot" as never, 160, 54);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: "rect", paint: "fill" });
  });
});

describe("pointsAttr", () => {
  it("writes the form both drawers want", () => {
    expect(
      pointsAttr([
        [1, 2],
        [3.5, 4],
      ]),
    ).toBe("1,2 3.5,4");
  });
});

describe("how far in from its box a shape's outline lies", () => {
  it("is nothing for a box", () => {
    expect(outlineDepth("square", 160, 54, "left", 10)).toBe(0);
    expect(outlineDepth("square", 160, 54, "top", 150)).toBe(0);
  });

  it("is nothing at a diamond's point, and grows away from it", () => {
    expect(outlineDepth("diamond", 150, 86, "right", 43)).toBe(0);
    // Halfway from the point to the corner the edge is about half of the
    // half-width in: the drawn point sits at 149, the edge at 112 there.
    expect(outlineDepth("diamond", 150, 86, "right", 22)).toBeCloseTo(37, 0);
    expect(outlineDepth("diamond", 150, 86, "top", 75 + 12.5)).toBeGreaterThan(5);
  });

  it("follows a circle round", () => {
    expect(outlineDepth("circle", 96, 96, "left", 48)).toBe(0);
    expect(outlineDepth("circle", 96, 96, "left", 20)).toBeGreaterThan(5);
  });

  it("is nothing along the flat of a rounded box, and something at its corners", () => {
    expect(outlineDepth("stadium", 160, 54, "top", 80)).toBe(0);
    expect(outlineDepth("stadium", 160, 54, "left", 27)).toBeCloseTo(0, 0);
    expect(outlineDepth("stadium", 160, 54, "left", 8)).toBeGreaterThan(3);
  });

  it("reaches a cylinder's lid, not the top of its box", () => {
    expect(outlineDepth("cylinder", 160, 80, "top", 80)).toBe(0);
    expect(outlineDepth("cylinder", 160, 80, "top", 20)).toBeGreaterThan(1);
    expect(outlineDepth("cylinder", 160, 80, "left", 40)).toBe(0);
  });
});
