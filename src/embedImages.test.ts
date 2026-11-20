import { afterEach, describe, expect, it, vi } from "vitest";
import { embedImages, forgetFetchedImages } from "./embedImages";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const code = (...links: string[]) =>
  `flowchart TB\n${links.map((l, i) => `  n${i}@{ img: "${l}", label: "N${i}", pos: "b" }`).join("\n")}\n`;

/** A desktop shell that answers with a picture for every link but the ones named. */
function shell(refuse: string[] = []) {
  const fetchImages = vi.fn(async (urls: string[]) => ({
    images: Object.fromEntries(urls.filter((u) => !refuse.includes(u)).map((u) => [u, PNG])),
    failed: urls.filter((u) => refuse.includes(u)),
  }));
  (globalThis as { archyne?: unknown }).archyne = { fetchImages };
  return fetchImages;
}

afterEach(() => {
  delete (globalThis as { archyne?: unknown }).archyne;
  forgetFetchedImages();
});

describe("bringing an imported drawing's pictures in as data", () => {
  it("carries a picture from elsewhere on the web in the diagram", async () => {
    shell();
    const out = await embedImages(code("https://cdn2.iconfinder.com/a.png"));
    expect(out.code).toContain(`img: "${PNG}"`);
    expect(out.code).not.toContain("iconfinder");
    expect(out).toMatchObject({ embedded: 1, failed: 0 });
  });

  it("leaves a picture the page already loads as the link it is", async () => {
    const fetchImages = shell();
    const link = "https://raw.githubusercontent.com/jgraph/drawio/dev/x.svg";
    const out = await embedImages(code(link));
    expect(out.code).toContain(link);
    expect(fetchImages).not.toHaveBeenCalled();
  });

  it("keeps the link of a picture the shell could not fetch, and counts it", async () => {
    shell(["https://example.com/gone.png"]);
    const out = await embedImages(
      code("https://example.com/gone.png", "https://example.com/here.png"),
    );
    expect(out.code).toContain("https://example.com/gone.png");
    expect(out).toMatchObject({ embedded: 1, failed: 1 });
  });

  it("fetches a picture once, however often the preview converts again", async () => {
    const fetchImages = shell();
    const link = "https://example.com/a.png";
    await embedImages(code(link, link));
    await embedImages(code(link));
    expect(fetchImages).toHaveBeenCalledTimes(1);
    expect(fetchImages.mock.calls[0][0]).toEqual([link]);
  });

  it("refuses anything the shell hands back that is not a picture", async () => {
    (globalThis as { archyne?: unknown }).archyne = {
      fetchImages: async () => ({
        images: { "https://example.com/a.png": "javascript:1" },
        failed: [],
      }),
    };
    const out = await embedImages(code("https://example.com/a.png"));
    expect(out.code).toContain("https://example.com/a.png");
    expect(out).toMatchObject({ embedded: 0, failed: 1 });
  });

  it("changes nothing in a browser, with no shell to ask", async () => {
    const source = code("https://cdn2.iconfinder.com/a.png");
    expect(await embedImages(source)).toEqual({ code: source, embedded: 0, failed: 0 });
  });
});
