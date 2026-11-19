import { describe, expect, it } from "vitest";
import { stencilPicture, tilePicture } from "./drawioPictures";
import { stencilsFromXml } from "./drawioStencils";
import { stencilBody } from "./stencilSvg";

/** The SVG inside a picture's data URL. */
const svgOf = (picture: string | null) =>
  atob(picture!.replace(/^data:image\/svg\+xml;base64,/, ""));

/**
 * A made-up library in draw.io's stencil format: a box with a bar across it,
 * drawn in the cell's colours; a mark that paints itself; and one that
 * includes another.
 */
const LIBRARY = stencilsFromXml(`
<shapes name="mxgraph.test">
  <shape name="Box Bar" w="40" h="20" aspect="variable" strokewidth="inherit">
    <background><rect x="0" y="0" w="40" h="20"/></background>
    <foreground>
      <fillstroke/>
      <path><move x="0" y="10"/><line x="40" y="10"/></path>
      <stroke/>
    </foreground>
  </shape>
  <shape name="Mark" w="10" h="10" aspect="fixed" strokewidth="2">
    <foreground>
      <fillcolor color="#ff0000"/>
      <ellipse x="0" y="0" w="10" h="10"/>
      <fill/>
    </foreground>
  </shape>
  <shape name="Both" w="20" h="10" aspect="variable" strokewidth="inherit">
    <foreground>
      <include-shape name="mxgraph.test.mark" x="10" y="0" w="10" h="10"/>
    </foreground>
  </shape>
</shapes>`);
const lookup = (name: string) => LIBRARY.get(name);
const paint = { fill: "#036897", stroke: "#ffffff", strokeWidth: 2 };

describe("draw.io stencils", () => {
  it("are found by draw.io's own names, spaces as underscores, lower case", () => {
    expect([...LIBRARY.keys()]).toEqual([
      "mxgraph.test.box_bar",
      "mxgraph.test.mark",
      "mxgraph.test.both",
    ]);
  });

  it("are run in the cell's colours, scaled to its box", () => {
    const body = stencilBody(lookup("mxgraph.test.box_bar")!, 80, 40, paint, lookup)!;
    // The background, filled and stroked by the foreground's first `fillstroke`.
    expect(body).toContain(
      'd="M0 0h80v40h-80Z" fill="#036897" stroke="#ffffff" stroke-width="2"',
    );
    // The bar across the middle, stroked only.
    expect(body).toContain('d="M0 20L80 20" fill="none" stroke="#ffffff"');
  });

  it("keep their own colours and their proportions when they ask to", () => {
    const body = stencilBody(lookup("mxgraph.test.mark")!, 40, 20, paint, lookup)!;
    expect(body).toContain('fill="#ff0000"');
    // `aspect="fixed"`: a circle 20 across, centred in the 40 × 20 box.
    expect(body).toContain("M10 10a10 10 0 1 0 20 0");
  });

  it("take the colours they name from the cell", () => {
    // draw.io stencils say `fill`, `stroke`, or the name of a style property.
    const named = stencilsFromXml(`
      <shapes name="mxgraph.test">
        <shape name="Named" w="10" h="10" aspect="variable" strokewidth="inherit">
          <foreground>
            <fillcolor color="fill"/><rect x="0" y="0" w="5" h="5"/><fill/>
            <fillcolor color="neutralFill"/><rect x="5" y="5" w="5" h="5"/><fill/>
            <fillcolor color="notInTheStyle"/><rect x="0" y="5" w="5" h="5"/><fill/>
          </foreground>
        </shape>
      </shapes>`).get("mxgraph.test.named")!;
    const body = stencilBody(
      named,
      10,
      10,
      { ...paint, style: { neutralFill: "#9DA6A8" } },
      lookup,
    )!;
    const fills = [...body.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    // A name the style does not give leaves the colour as it was.
    expect(fills).toEqual(["#036897", "#9DA6A8", "#9DA6A8"]);
    expect(body).not.toMatch(/fill="(fill|neutralFill|notInTheStyle)"/);
  });

  it("draw the stencils they include", () => {
    const body = stencilBody(lookup("mxgraph.test.both")!, 20, 10, paint, lookup)!;
    expect(body).toContain('fill="#ff0000"');
  });

  it("are carried as pictures", () => {
    const svg = svgOf(stencilPicture(lookup("mxgraph.test.box_bar")!, 40, 20, paint, lookup));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 40 20"/);
  });

  it("are drawn in the cell's own paint when a box names one", () => {
    const svg = svgOf(tilePicture(lookup("mxgraph.test.box_bar")!, 50, 50, paint, lookup));
    expect(svg).toContain('fill="#036897" stroke="#ffffff"');
    expect(svg).not.toContain("<rect");
  });

  it("are set on a tile of the cell's gradient when it has one", () => {
    const svg = svgOf(
      tilePicture(
        lookup("mxgraph.test.box_bar")!,
        50,
        50,
        { ...paint, fill: "#ED7100", gradient: "#945DF2" },
        lookup,
      ),
    );
    expect(svg).toContain('<rect x="0" y="0" width="50" height="50" fill="url(#t)"/>');
    expect(svg).toContain("translate(7.5 7.5)");
  });
});
