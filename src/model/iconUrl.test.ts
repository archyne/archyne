import { describe, expect, it } from "vitest";
// The page's own source, as text. Read through the bundler rather than with
// `node:fs`, because this project is type-checked as browser code.
import indexHtml from "../../index.html?raw";
import { MODEL_HOSTS } from "../ai/types";
import {
  fetchableInBrowser,
  ICON_HOSTS,
  iconNameFromUrl,
  iconSource,
  normaliseIconUrl,
  parseLinks,
} from "./iconUrl";

describe("a pasted icon link", () => {
  it("keeps an https link to a raw file as it is", () => {
    const url = "https://raw.githubusercontent.com/org/pack/main/azure/vnet.svg";
    expect(normaliseIconUrl(url)).toBe(url);
  });

  it("rewrites the GitHub page link, which is the one people actually have", () => {
    expect(normaliseIconUrl("https://github.com/org/pack/blob/main/azure/vnet.svg")).toBe(
      "https://raw.githubusercontent.com/org/pack/main/azure/vnet.svg",
    );
  });

  it("drops the fragment, which is for a browser and not for the server", () => {
    expect(normaliseIconUrl("https://unpkg.com/pack/vnet.svg#icon")).toBe(
      "https://unpkg.com/pack/vnet.svg",
    );
  });

  it("refuses anything that is not https", () => {
    expect(normaliseIconUrl("http://raw.githubusercontent.com/a/b/c.svg")).toBeNull();
    expect(normaliseIconUrl("file:///C:/icons/vnet.svg")).toBeNull();
    expect(normaliseIconUrl("javascript:alert(1)")).toBeNull();
  });

  it("refuses text that is not a link", () => {
    expect(normaliseIconUrl("")).toBeNull();
    expect(normaliseIconUrl("vnet.svg")).toBeNull();
    expect(normaliseIconUrl("the icons are on GitHub")).toBeNull();
  });
});

describe("what the browser build will request", () => {
  it("takes an SVG from a host on the list", () => {
    for (const host of ICON_HOSTS) {
      expect(fetchableInBrowser(`https://${host}/pack/vnet.svg`), host).toBe(true);
    }
  });

  it("refuses a host that is not on it, however plausible", () => {
    expect(fetchableInBrowser("https://learn.microsoft.com/icons/vnet.svg")).toBe(false);
    // Not a prefix match: the host has to *be* one of them.
    expect(fetchableInBrowser("https://unpkg.com.example.org/vnet.svg")).toBe(false);
  });

  it("refuses what is not an SVG, including a vendor's zip", () => {
    expect(fetchableInBrowser("https://unpkg.com/pack/icons.zip")).toBe(false);
    expect(fetchableInBrowser("https://unpkg.com/pack/README.md")).toBe(false);
  });
});

describe("an icon from Iconify's API", () => {
  it("is fetchable, which is what puts 200 000 icons within reach", () => {
    expect(fetchableInBrowser("https://api.iconify.design/mdi/database.svg")).toBe(true);
  });

  it("keeps the set in its name, so two databases are two icons", () => {
    expect(iconNameFromUrl(iconSource("https://api.iconify.design/mdi/database.svg"))).toBe(
      "mdi-database",
    );
    expect(
      iconNameFromUrl(iconSource("https://api.iconify.design/fluent-emoji/rocket.svg")),
    ).toBe("fluent-emoji-rocket");
  });

  it("keeps the colour a request asks for, and drops it from the name", () => {
    const url = "https://api.iconify.design/mdi/database.svg?color=%23fff";
    expect(iconSource(url)).toBe("https://api.iconify.design/mdi/mdi-database.svg");
  });

  it("leaves every other host's URL as it is", () => {
    const raw = "https://raw.githubusercontent.com/o/r/main/azure/Subnet.svg";
    expect(iconSource(raw)).toBe(raw);
    expect(iconSource(`${raw}?v=2`)).toBe(raw);
  });
});

describe("the name a downloaded icon is filed under", () => {
  it("comes from the filename, cleaned as an imported file's would be", () => {
    expect(
      iconNameFromUrl("https://raw.githubusercontent.com/o/r/main/Virtual%20Networks.svg"),
    ).toBe("virtual-networks");
  });

  it("ignores the query a CDN may have added", () => {
    expect(iconNameFromUrl("https://cdn.jsdelivr.net/npm/p/vnet.svg?v=2")).toBe("vnet");
  });
});

describe("links out of pasted text", () => {
  it("takes them one per line, and also however else they arrived", () => {
    expect(parseLinks("https://a/1.svg\nhttps://a/2.svg, https://a/3.svg")).toEqual([
      "https://a/1.svg",
      "https://a/2.svg",
      "https://a/3.svg",
    ]);
  });

  it("strips the quotes and brackets that come with a copied list", () => {
    expect(parseLinks('"https://a/1.svg" <https://a/2.svg>')).toEqual([
      "https://a/1.svg",
      "https://a/2.svg",
    ]);
  });

  it("does not ask for the same file twice", () => {
    expect(parseLinks("https://a/1.svg https://a/1.svg")).toEqual(["https://a/1.svg"]);
  });
});

describe("the content security policy", () => {
  // The allowlist above decides nothing on its own: if `connect-src` does not
  // name a host, the request never leaves, and if it names one this module
  // does not, the page is reachable from further away than intended. The two
  // are one decision written twice, so they are checked against each other.
  // The policy itself, not the comment above it that also names the directive.
  const policy = /Content-Security-Policy"\s*content="([^"]*)"/.exec(indexHtml)?.[1] ?? "";
  const connectSrc = /connect-src([^;]*);/.exec(policy)?.[1] ?? "";

  it("names every host the fetcher is willing to use", () => {
    for (const host of ICON_HOSTS) {
      expect(connectSrc, host).toContain(`https://${host}`);
    }
  });

  it("lets the same hosts be drawn as images, for mermaid's image shape", () => {
    // A node whose picture is a URL is the one icon form that survives
    // leaving Archyne, and `img-src` is what decides whether it draws here.
    const imgSrc = /img-src([^;]*);/.exec(policy)?.[1] ?? "";
    for (const host of ICON_HOSTS) {
      expect(imgSrc, host).toContain(`https://${host}`);
    }
    expect(imgSrc.trim().split(/\s+/)).not.toContain("*");
  });

  it("names every host the local model's weights come from", () => {
    // The other opt-in feature that reaches out: running the model in the
    // tab fetches its ONNX weights. Same bargain as the icons — the list
    // lives in code, and the policy has to agree with it.
    for (const host of MODEL_HOSTS) {
      expect(connectSrc, host).toContain(`https://${host}`);
    }
  });

  it("names no others, and never opens up to everything", () => {
    const allowed = connectSrc.trim().split(/\s+/);
    expect(allowed).not.toContain("*");
    expect(allowed).not.toContain("https:");
    expect(allowed.sort()).toEqual(
      [
        "'self'",
        ...ICON_HOSTS.map((h) => `https://${h}`),
        ...MODEL_HOSTS.map((h) => `https://${h}`),
      ].sort(),
    );
  });
});
