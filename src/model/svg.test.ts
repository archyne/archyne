import { describe, expect, it } from "vitest";
import { sanitiseSvg, svgToIcon } from "./svg";

const wrap = (inner: string, attrs = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe("making an imported icon safe to draw", () => {
  it("keeps the colours an icon writes in its style, as attributes", () => {
    // Inkscape, and Microsoft's Azure icons with it, paint every shape from
    // its `style`. Dropped whole, each icon came out a black silhouette.
    const out = sanitiseSvg(
      wrap(
        '<path d="M0 0" style="fill:url(#a);stroke:none;fill-opacity:0.5"/>' +
          '<path d="M1 1" fill="#000" style="fill:#50e6ff"/>',
      ),
    )!;
    expect(out).toContain('fill="url(#a)"');
    expect(out).toContain('stroke="none"');
    expect(out).toContain('fill-opacity="0.5"');
    // The style wins over the attribute, as it does in a browser.
    expect(out).toContain('fill="#50e6ff"');
    expect(out).not.toContain("style=");
  });

  it("takes nothing from a style that an attribute could not say", () => {
    const out = sanitiseSvg(
      wrap(
        '<path d="M0 0" style="fill:url(http://x/a.svg#a);background:url(javascript:alert(1));' +
          'behavior:url(x.htc);href:#a"/>',
      ),
    )!;
    expect(out).not.toContain("http://x");
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("behavior");
    expect(out).not.toContain("href");
    expect(out).not.toContain("style=");
  });

  it("keeps the shapes an icon is made of", () => {
    const out = sanitiseSvg(
      wrap('<path d="M1 1L9 9" fill="#0078d4"/><circle cx="5" cy="5" r="2"/>'),
    );
    expect(out).toContain("<path");
    expect(out).toContain('d="M1 1L9 9"');
    expect(out).toContain('fill="#0078d4"');
    expect(out).toContain("<circle");
  });

  it("keeps a gradient, which the vendor packs use", () => {
    const out = sanitiseSvg(
      wrap(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
          '<rect width="10" height="10" fill="url(#g)"/>',
      ),
    );
    expect(out).toContain("linearGradient");
    expect(out).toContain("stop-color");
    expect(out).toContain('fill="url(#g)"');
  });

  it("takes out a script", () => {
    const out = sanitiseSvg(wrap('<script>alert(1)</script><path d="M0 0"/>'));
    expect(out).not.toContain("script");
    expect(out).toContain("<path");
  });

  it("takes out an event handler", () => {
    const out = sanitiseSvg(wrap('<path d="M0 0" onload="alert(1)" onclick="alert(2)"/>'));
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
  });

  it("takes out anything that reaches off the page", () => {
    const out = sanitiseSvg(
      wrap('<image href="https://example.com/x.png"/><use href="https://example.com/#a"/>'),
    );
    expect(out).not.toContain("example.com");
  });

  it("keeps a reference that stays inside the icon", () => {
    const out = sanitiseSvg(wrap('<defs><path id="a" d="M0 0"/></defs><use href="#a"/>'));
    expect(out).toContain('href="#a"');
  });

  it("refuses a javascript url wherever it is hiding", () => {
    const out = sanitiseSvg(wrap('<path d="M0 0" fill="url(javascript:alert(1))"/>'));
    expect(out).not.toContain("javascript");
  });

  it("takes out a stylesheet rather than reading it", () => {
    const out = sanitiseSvg(wrap('<style>@import url(http://x);</style><path d="M0 0"/>'));
    expect(out).not.toContain("@import");
    expect(out).not.toContain("style");
  });

  it("takes out foreign content", () => {
    const out = sanitiseSvg(wrap("<foreignObject><body>hi</body></foreignObject>"));
    expect(out).not.toContain("foreignObject");
  });

  it("drops the fixed size but keeps the box, so it scales", () => {
    const out = sanitiseSvg(
      wrap('<path d="M0 0"/>', 'viewBox="0 0 24 24" width="512" height="512"'),
    );
    expect(out).toContain("viewBox");
    expect(out).not.toContain('width="512"');
  });

  it("says so when the file is not an icon", () => {
    expect(sanitiseSvg("<html><body>no</body></html>")).toBeNull();
    expect(sanitiseSvg("not markup at all")).toBeNull();
    expect(sanitiseSvg("<svg><unclosed>")).toBeNull();
  });
});

describe("an icon that arrived with no box", () => {
  it("gets one made from the size it did have", () => {
    // Vendors ship these — draw.io's Azure `Subnet.svg` among them — and
    // stripping width and height without this left them with no dimensions.
    const clean = sanitiseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16.998" height="10.175"><path d="M0 0"/></svg>',
    );
    expect(clean).toContain('viewBox="0 0 16.998 10.175"');
    expect(clean).not.toContain('width="16.998"');
    expect(svgToIcon(clean!)).toMatchObject({ width: 17, height: 10 });
  });

  it("keeps the box the file already had", () => {
    const clean = sanitiseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="99"><path d="M0 0"/></svg>',
    );
    expect(clean).toContain('viewBox="0 0 18 18"');
    expect(clean).not.toContain("99");
  });

  it("invents nothing when there is nothing to go on", () => {
    const clean = sanitiseSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    expect(clean).not.toContain("viewBox");
  });
});

describe("taking an icon apart for an icon pack", () => {
  it("keeps the markup and reads the box", () => {
    const icon = svgToIcon('<svg viewBox="0 0 18 18"><path d="M0 0"/></svg>');
    expect(icon).toEqual({ body: '<path d="M0 0"/>', width: 18, height: 18 });
  });

  it("falls back to width and height when there is no box", () => {
    const icon = svgToIcon('<svg width="24" height="24"><circle r="2"/></svg>');
    expect(icon).toMatchObject({ width: 24, height: 24 });
  });

  it("refuses what it cannot size, rather than guessing", () => {
    expect(svgToIcon('<svg><path d="M0 0"/></svg>')).toBeNull();
    expect(svgToIcon('<svg viewBox="0 0 0 0"><path d="M0 0"/></svg>')).toBeNull();
    expect(svgToIcon("not markup at all")).toBeNull();
    expect(svgToIcon('<svg viewBox="0 0 18 18"></svg>')).toBeNull();
  });
});
