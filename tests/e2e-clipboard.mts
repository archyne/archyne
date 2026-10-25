/**
 * E2E: copy from the canvas to other applications, and paste a picture from
 * anywhere onto it.
 *
 * The store's half — which part is copied, what Mermaid it makes, the image
 * node a picture becomes — has unit tests. This covers what only a browser
 * can: that Ctrl+C really leaves text, a PNG and HTML on the system
 * clipboard, and that Ctrl+V with a picture on it really lands one.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-clipboard.mts [output-prefix]
 */
import { chromium, type Page } from "playwright";
import { writeFileSync } from "node:fs";
import { CHANNEL, BASE } from "./env.mts";

const PREFIX = (process.argv[2] ?? "clipboard-e2e").replace(/\.png$/, "");

interface Node {
  id: string;
  selected?: boolean;
  data: { img?: string };
}
interface TestApi {
  ready: () => boolean;
  store: {
    getState: () => { code: string; nodes: Node[]; applyCode: (code: string) => Promise<void> };
  };
}

/**
 * The page's test hook, by a type of this file's own: declared as a global,
 * it would clash with the other scripts' own declarations of it.
 */
type Api = { __graphTest: TestApi };

let failures = 0;
function check(what: string, ok: boolean) {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
}

/**
 * Wait for a copy to land: text holding `needle`, with its picture beside it.
 * The picture is drawn after the key press, so the clipboard fills a moment
 * later. Not `waitForFunction`, which takes an async predicate's promise for
 * a truthy answer and returns at once.
 */
function copied(page: Page, needle: string): Promise<boolean> {
  return page.evaluate(async (needle) => {
    for (let i = 0; i < 150; i++) {
      const [item] = await navigator.clipboard.read();
      if (
        item?.types.includes("image/png") &&
        item.types.includes("text/plain") &&
        (await (await item.getType("text/plain")).text()).includes(needle)
      ) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }, needle);
}

/**
 * Wait for the clipboard to change to something `test` accepts, by the same
 * polling as `copied`, and say what it holds.
 */
async function holds(
  page: Page,
  test: (types: string) => boolean,
): Promise<{ types: string; text: string }> {
  for (let i = 0; i < 150; i++) {
    const now = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const types = item ? [...item.types].sort().join("+") : "";
      const text = item?.types.includes("text/plain")
        ? await (await item.getType("text/plain")).text()
        : "";
      return { types, text };
    });
    if (test(now.types)) return now;
    await page.waitForTimeout(100);
  }
  return { types: "(nothing that matched)", text: "" };
}

const DIAGRAM = 'flowchart LR\n  a["Front door"] --> b["Back office"]\n  b --> c["Ledger"]\n';

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[console]", m.text());
  });
  await page.goto(BASE);
  await page.waitForFunction(
    () => (window as unknown as { __graphTest?: TestApi }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );
  await page.evaluate(
    (code) => (window as unknown as Api).__graphTest.store.getState().applyCode(code),
    DIAGRAM,
  );
  await page.locator('.react-flow__node[data-id="c"]').waitFor();
  const count = () =>
    page.evaluate(() => (window as unknown as Api).__graphTest.store.getState().nodes.length);

  console.log("\ncopy from the canvas");
  {
    await page.locator('.react-flow__node[data-id="a"]').click();
    await page
      .locator('.react-flow__node[data-id="b"]')
      .click({ modifiers: ["ControlOrMeta"] });
    await page.keyboard.press("Control+C");
    check("the copy reached the clipboard", await copied(page, "Front door"));
    const got = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const text = await (await item.getType("text/plain")).text();
      const html = item.types.includes("text/html")
        ? await (await item.getType("text/html")).text()
        : "";
      const png = await item.getType("image/png");
      const bitmap = await createImageBitmap(png);
      const bytes = Array.from(new Uint8Array(await png.arrayBuffer()));
      // A corner, outside every shape: the page it is pasted on shows there.
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const corner = g.getImageData(2, 2, 1, 1).data[3];
      return {
        types: item.types,
        text,
        html,
        width: bitmap.width,
        height: bitmap.height,
        bytes,
        corner,
      };
    });
    writeFileSync(`${PREFIX}-copied.png`, Buffer.from(got.bytes));
    check(`text, a picture and HTML (got ${got.types.join(", ")})`, got.types.length === 3);
    check("the text is the selection's Mermaid", got.text.includes("a --> b"));
    check("and only the selection's", !got.text.includes("Ledger"));
    check(
      `the picture has a size (${got.width}×${got.height})`,
      got.width > 100 && got.height > 20,
    );
    check("the HTML carries the picture", /<img[^>]+src="data:image\/png/.test(got.html));
    check(`it has no background (corner alpha ${got.corner})`, got.corner === 0);
  }

  console.log("\npaste the app's own copy");
  {
    const before = await count();
    await page.keyboard.press("Control+V");
    await page.waitForFunction(
      (n) => (window as unknown as Api).__graphTest.store.getState().nodes.length === n + 2,
      before,
    );
    const imgs = await page.evaluate(
      () =>
        (window as unknown as Api).__graphTest.store.getState().nodes.filter((n) => n.data.img)
          .length,
    );
    check("it comes back as the two nodes, not as their picture", imgs === 0);
  }

  console.log("\npaste a picture from elsewhere");
  {
    // As a browser's "Copy image" leaves it: a PNG and nothing else.
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 300;
      canvas.height = 150;
      const g = canvas.getContext("2d")!;
      // Two halves of two colours, so a crop can be told by what is left.
      g.fillStyle = "#e8743b";
      g.fillRect(0, 0, 150, 150);
      g.fillStyle = "#2f6fdf";
      g.fillRect(150, 0, 150, 150);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    });
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    const before = await count();
    await page.keyboard.press("Control+V");
    await page.waitForFunction(
      (n) => (window as unknown as Api).__graphTest.store.getState().nodes.length === n + 1,
      before,
    );
    const pasted = await page.evaluate(() => {
      const s = (window as unknown as Api).__graphTest.store.getState();
      const n = s.nodes.at(-1)!;
      return { img: n.data.img ?? "", selected: n.selected, id: n.id, code: s.code };
    });
    check("it became an image node", pasted.img.startsWith("data:image/png"));
    check("selected, ready to move", pasted.selected === true);
    check("and is in the Mermaid", pasted.code.includes(`${pasted.id}@{ img: "data:image/png`));
    const shown = page.locator(`.react-flow__node[data-id="${pasted.id}"] img`);
    await shown.waitFor({ timeout: 10000 });
    const box = (await shown.boundingBox())!;
    check(
      `drawn at its own proportions (${Math.round(box.width)}×${Math.round(box.height)})`,
      Math.abs(box.width / box.height - 2) < 0.1,
    );
    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-pasted.png` });
  }

  console.log("\ncrop a pasted picture");
  {
    const id = await page.evaluate(
      () => (window as unknown as Api).__graphTest.store.getState().nodes.at(-1)!.id,
    );
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Crop image…", exact: true }).click();
    const frame = page.getByTestId("crop-frame");
    await frame.waitFor({ timeout: 10000 });

    // By hand: the left grip dragged a third of the way in.
    const stage = (await page.locator(".crop-stage").boundingBox())!;
    const grip = (await page.locator('[data-grip="w"]').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 3, grip.y + grip.height / 2, { steps: 5 });
    await page.mouse.up();
    const left = Number(
      await page.locator(".modal").getByLabel("Left", { exact: true }).inputValue(),
    );
    check(`dragging a grip moves that edge (left now ${left})`, left > 80 && left < 120);
    await page.locator(".modal").screenshot({ path: `${PREFIX}-crop.png` });

    // By the numbers: exactly the right half.
    // Width first: a left edge the current width leaves no room for is
    // held back, so typed the other way round it would land short.
    await page.locator(".modal").getByLabel("Width", { exact: true }).fill("150");
    await page.locator(".modal").getByLabel("Left", { exact: true }).fill("150");
    await page.getByRole("button", { name: "Crop", exact: true }).click();
    await page.locator(".modal").waitFor({ state: "detached" });

    const after = await page.evaluate(async (id) => {
      const s = (window as unknown as Api).__graphTest.store.getState();
      const n = s.nodes.find((x) => x.id === id)!;
      const data = n.data as { img?: string; imgWidth?: number; imgHeight?: number };
      const img = new Image();
      img.src = data.img ?? "";
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      // At the left edge as well as the middle: a crop that kept a strip of
      // the orange half would pass on the middle alone.
      const blue = [1, img.naturalWidth / 2].every((x) => {
        const [r, , b] = g.getImageData(x, img.naturalHeight / 2, 1, 1).data;
        return b > r;
      });
      return {
        natural: `${img.naturalWidth}×${img.naturalHeight}`,
        shown: `${data.imgWidth}×${data.imgHeight}`,
        blue,
        inCode: s.code.includes(String(data.img).slice(0, 60)),
      };
    }, id);
    check(
      `the picture is cut to the part kept (${after.natural})`,
      after.natural === "150×150",
    );
    check("and it is that part, edge to edge", after.blue);
    check(`drawn at the scale it was (${after.shown})`, after.shown === "120×120");
    check("the Mermaid holds the cut picture", after.inCode);
  }

  console.log("\nresize a pasted picture");
  {
    const id = await page.evaluate(
      () => (window as unknown as Api).__graphTest.store.getState().nodes.at(-1)!.id,
    );
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    await node.click();
    const handle = node.locator(".react-flow__resize-control.handle.bottom.right");
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    // Down and only a little across: the box keeps the picture's proportions.
    await page.mouse.move(h.x + 40, h.y + 160, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate((id) => {
      const s = (window as unknown as Api).__graphTest.store.getState();
      const n = s.nodes.find((x) => x.id === id)! as unknown as {
        data: { imgWidth: number; imgHeight: number };
        style?: { width?: number };
      };
      const box = document
        .querySelector(`.react-flow__node[data-id="${id}"]`)!
        .getBoundingClientRect();
      const img = document
        .querySelector(`.react-flow__node[data-id="${id}"] img`)!
        .getBoundingClientRect();
      return {
        w: n.data.imgWidth,
        h: n.data.imgHeight,
        sized: n.style?.width !== undefined,
        // How much of the box is not picture, on screen.
        spareX: Math.round(box.width - img.width),
        spareY: Math.round(box.height - img.height),
        code: s.code,
      };
    }, id);
    check(`the picture grew with the box (${after.w}×${after.h})`, after.w > 120);
    check("in proportion", after.w === after.h);
    check("the box is the picture's again, not a size of its own", !after.sized);
    check(
      `and hugs it (spare ${after.spareX}×${after.spareY} px)`,
      after.spareX < 30 && after.spareY < 30,
    );
    check("the Mermaid has the new size", after.code.includes(`w: ${after.w}, h: ${after.h}`));
    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-resized.png` });
  }

  console.log("\nnothing selected");
  {
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+C");
    check("a copy takes the whole diagram", await copied(page, "Ledger"));
    const before = await count();
    await page.keyboard.press("Control+V");
    await page.waitForTimeout(500);
    check("pasting it back adds nothing", (await count()) === before);
  }

  console.log("\nthe menu forces one form");
  {
    const node = page.locator('.react-flow__node[data-id="c"]');
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy as image", exact: true }).click();
    const image = await holds(page, (types) => types.includes("image/png"));
    check(
      `"Copy as image" leaves the picture alone (got ${image.types})`,
      !image.types.includes("text/plain"),
    );

    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy as text", exact: true }).click();
    const text = await holds(
      page,
      (types) => types.includes("text/plain") && !types.includes("image/png"),
    );
    check(
      `"Copy as text" leaves the Mermaid alone (got ${text.types})`,
      text.types === "text/plain",
    );
    check(
      "and it is the node's",
      text.text.includes("Ledger") && !text.text.includes("Front door"),
    );

    // A picture copied on purpose and pasted back here is meant as one.
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy as image", exact: true }).click();
    await holds(page, (types) => types.includes("image/png"));
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    const before = await count();
    await page.keyboard.press("Control+V");
    await page.waitForFunction(
      (n) => (window as unknown as Api).__graphTest.store.getState().nodes.length === n + 1,
      before,
    );
    const last = await page.evaluate(
      () =>
        (window as unknown as Api).__graphTest.store.getState().nodes.at(-1)!.data.img ?? "",
    );
    check("pasted back, it arrives as a picture", last.startsWith("data:image/png"));
  }

  console.log(`\nsaved ${PREFIX}-*.png`);
  if (failures) throw new Error(`${failures} check(s) failed`);
} finally {
  await browser.close();
}
