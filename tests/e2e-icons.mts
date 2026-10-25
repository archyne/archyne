/**
 * Picking an icon, with a real pointer.
 *
 * This exists because of a bug nothing else could have caught. `IconView`
 * renders its SVG through `innerHTML`, so every re-render replaced the icon's
 * `<svg>` node — and the browser only fires a `click` when the press and the
 * release land on a node that is still in the document. Any re-render between
 * mousedown and mouseup (a hover, a store update, an icon finishing loading)
 * therefore ate the click: the icon you clicked simply did not apply, with no
 * error anywhere. Unit tests fire synthetic clicks and see none of that.
 *
 * So the clicks here are deliberately the ordinary, fast kind, and what is
 * asserted is that the diagram changed.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-icons.mts
 */
import { chromium } from "playwright";
import { CHANNEL, codeUrl } from "./env.mts";

const CODE = `architecture-beta
  service svc(server)[Service]
`;

let failed = false;

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed = true;
    console.error(`✗ ${label} — ${detail}`);
  }
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));

interface TestNode {
  type: string;
  data: { icon?: string; styles?: string[] };
}
const nodes = () =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __graphTest: { store: { getState(): { nodes: TestNode[] } } };
        }
      ).__graphTest.store.getState().nodes,
  );

await page.goto(codeUrl(CODE));
await page.waitForSelector(".service-node");
await page.waitForTimeout(1500);

/* ---------- the picker ---------- */

await page.locator(".service-node").first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /Choose icon/i }).click();
await page.waitForTimeout(600);

const cells = page.locator(".modal .icon-add");
check("the picker offers icons", (await cells.count()) > 0, `${await cells.count()} cells`);

await cells.nth(0).hover();
await page.waitForTimeout(150);
const hoveredName = (await cells.nth(0).getAttribute("aria-label")) ?? "";
check(
  "hovering one says which one it is",
  (await page.locator(".icon-readout").innerText()) === hoveredName,
  `readout said "${await page.locator(".icon-readout").innerText()}", expected "${hoveredName}"`,
);

// Deliberately a cell the pointer has *not* been over, clicked in one go:
// arriving is what re-renders the grid, and the whole bug was that the
// re-render landed between the press and the release. Hovering first, then
// clicking, quietly avoids it and proves nothing.
await page.locator(".modal .icon-search").hover();
await page.waitForTimeout(150);
const cell = cells.nth(3);
const wanted = (await cell.getAttribute("aria-label")) ?? "";
await cell.click();
await page.waitForTimeout(500);
check(
  "clicking one closes the picker",
  (await page.locator(".modal").count()) === 0,
  "still open",
);
check(
  "and the node actually gets that icon",
  (await nodes())[0]?.data.icon === wanted,
  `node carries ${JSON.stringify((await nodes())[0]?.data.icon)}, expected ${wanted}`,
);
check(
  "which the reference field shows too",
  (await page.locator(".inspector input").nth(1).inputValue()) === wanted,
  await page.locator(".inspector input").nth(1).inputValue(),
);

/* ---------- taking it off again ---------- */

// If the pick above failed, the dialog is still up and everything after it
// would report the same failure as a timeout. Close it and carry on.
if ((await page.locator(".modal").count()) > 0) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

await page.getByRole("button", { name: /Choose icon/i }).click();
await page.waitForTimeout(500);
await page.getByRole("button", { name: "No icon" }).click();
await page.waitForTimeout(500);
check(
  '"No icon" takes it off',
  !(await nodes())[0]?.data.icon,
  `node still carries ${JSON.stringify((await nodes())[0]?.data.icon)}`,
);

/* ---------- the palette, which clicks the same way ---------- */

const before = (await nodes()).length;
await page.locator(".palette .icon-cell .icon-add").first().click();
await page.waitForTimeout(800);
const after = await nodes();
check(
  "a click in the palette adds the node it drew",
  after.length === before + 1 && Boolean(after[after.length - 1]?.data.icon),
  `${before} nodes became ${after.length}`,
);

/* ---------- the picture shape on a flowchart node ---------- */

// Whether a picture fits inside the shape drawn around it is a question only
// a browser can answer: the box is a fixed width and height, and the picture
// is loaded from the network at its own size.
await page.goto(
  codeUrl(
    'flowchart TD\n  s["Start"] --> w@{ img: "https://api.iconify.design/logos/aws-dynamodb.svg", label: "Process request", pos: "b", w: 60, h: 60 }\n',
  ),
);
await page.waitForSelector(".shape-image");
await page.waitForTimeout(2000);

const spill = () =>
  page.evaluate(() => {
    const img = document.querySelector(".shape-image") as HTMLElement;
    const node = img.closest(".shape-node") as HTMLElement;
    const nb = node.getBoundingClientRect();
    const ib = img.getBoundingClientRect();
    const label = node.querySelector(".shape-label")!.getBoundingClientRect();
    const plain = document.querySelector(".shape-node") as HTMLElement;
    return {
      top: Math.round(nb.top - ib.top),
      bottom: Math.round(label.bottom - nb.bottom),
      imageHeight: Math.round(ib.height),
      nodeHeight: Math.round(nb.height),
      plainHeight: Math.round(plain.getBoundingClientRect().height),
    };
  });

const fitted = await spill();
check(
  "the picture stays inside the shape",
  fitted.top <= 0 && fitted.bottom <= 0 && fitted.imageHeight > 0,
  `${fitted.top}px out of the top, ${fitted.bottom}px out of the bottom`,
);
check(
  "and the shape is the size it would be without one",
  fitted.nodeHeight === fitted.plainHeight,
  `${fitted.nodeHeight}px against a plain node's ${fitted.plainHeight}px`,
);

// And a node made smaller than its picture shrinks the picture, rather than
// letting it hang out of the shape again.
await page.locator(".shape-node").nth(1).click();
await page.waitForTimeout(400);
const size = page.locator(".inspector .size-row").last().locator("input[type=number]");
await size.nth(0).fill("110");
await size.nth(0).blur();
await size.nth(1).fill("48");
await size.nth(1).blur();
await page.waitForTimeout(800);
const squeezed = await spill();
check(
  "and still fits when the node is made smaller than it",
  squeezed.top <= 0 && squeezed.bottom <= 0,
  `${squeezed.top}px out of the top, ${squeezed.bottom}px out of the bottom`,
);

check(
  "the picture shows on the button that changes it",
  await page.evaluate(() => {
    const swatch = document.querySelector(".icon-choose-preview");
    return Boolean(swatch?.querySelector("img")?.getAttribute("src"));
  }),
  "the preview swatch was empty",
);

/* ---------- the type size, which only a browser can confirm ---------- */

// `font-size` is a label style in mermaid's own reckoning, and Archyne kept
// it in the file while drawing every label at 12px regardless — a diagram
// that said one thing here and another everywhere else.
await page.goto(
  codeUrl('flowchart TD\n  a["Normal"] --> b["Bigger"]\n  style b font-size:22px\n'),
);
await page.waitForSelector(".shape-node");
await page.waitForTimeout(1200);
check(
  "a chosen type size is actually drawn",
  (await page.$$eval(".shape-label", (ls) => ls.map((l) => getComputedStyle(l).fontSize))).join(
    " ",
  ) === "12px 22px",
  await page.$$eval(".shape-label", (ls) =>
    ls.map((l) => getComputedStyle(l).fontSize).join(" "),
  ),
);

await page.locator(".shape-node").nth(1).click();
await page.waitForTimeout(400);
const typeSize = page.locator(".inspector .type-size input");
check(
  "and the field shows it",
  (await typeSize.inputValue()) === "22",
  await typeSize.inputValue(),
);

const styleLine = async () =>
  (
    await page.evaluate(
      () =>
        (
          window as unknown as { __graphTest: { store: { getState(): { code: string } } } }
        ).__graphTest.store.getState().code,
    )
  )
    .split("\n")
    .find((l) => l.includes("style b")) ?? "";

await typeSize.fill("30");
await page.waitForTimeout(700);
check(
  "changing it writes ordinary mermaid",
  (await styleLine()).includes("font-size:30px"),
  await styleLine(),
);

// Back at the default the declaration comes out rather than being spelled
// on every node: 12px written down is 12px nobody chose.
await typeSize.fill("12");
await page.waitForTimeout(700);
check(
  "and back at the default it comes out of the file",
  !(await styleLine()).includes("font-size"),
  await styleLine(),
);

/* ---------- and an icon arrives without a frame around it ---------- */

// An icon is a picture, not a box with a picture in it. Mermaid draws its
// frame tight around the image from the node's own `fill` and `stroke`, so
// the two are switched off when the picture goes on — and back on when it
// comes off, or the node would be left invisible.
await page.goto(codeUrl('flowchart TD\n  s["Start"] --> w["Next step"]\n'));
await page.waitForSelector(".shape-node");
await page.waitForTimeout(1500);
await page.locator(".shape-node").nth(1).click();
await page.waitForTimeout(400);

const url = page.locator(".inspector input[placeholder^='https']");
// The look, asked in the same words a service is asked it: a box with the
// icon in it, or the icon alone. It is the last select in the panel — the
// shape comes first.
const look = page.locator(".inspector select").last();
const styles = async () => (await nodes())[1]?.data.styles ?? [];
const setUrl = async (value: string) => {
  await url.fill(value);
  await url.blur();
  await page.waitForTimeout(700);
};

await setUrl("https://api.iconify.design/logos/google-cloud.svg");
check(
  "taking a picture on takes the frame off",
  (await styles()).includes("fill:none") && (await styles()).includes("stroke:none"),
  JSON.stringify(await styles()),
);
check(
  "which the look shows",
  (await look.inputValue()) === "icon",
  `the look says ${await look.inputValue()}`,
);

// And with no frame there is no box to fit into, so the node stops being a
// 160×54 rectangle standing clear of a 60px logo.
const box = () =>
  page.evaluate(() => {
    const r = document.querySelectorAll(".shape-node")[1].getBoundingClientRect();
    const i = document.querySelector(".shape-image")!.getBoundingClientRect();
    return {
      slack: Math.round(r.width - i.width),
      size: `${Math.round(r.width)}×${Math.round(r.height)}`,
    };
  });
const hugged = await box();
check(
  "and the node shrinks onto the picture",
  hugged.slack < 40,
  `${hugged.slack}px of node either side of the picture, in a ${hugged.size} box`,
);

// Renaming replaced the whole label block, picture included, which on an
// unframed node left a lone text box where the icon had been.
await page.locator(".shape-node").nth(1).dblclick();
await page.waitForTimeout(400);
// A node that is its own contents is a node the rename field can resize, so
// the field takes exactly the room the name took and nothing moves.
const typing = await box();
check(
  "and renaming does not resize the node",
  typing.size === hugged.size,
  `${hugged.size} at rest became ${typing.size} while renaming`,
);
check(
  "renaming leaves the picture where it is",
  await page.evaluate(() => {
    const node = document.querySelectorAll(".shape-node")[1];
    const field = node.querySelector(".node-rename");
    return Boolean(node.querySelector(".shape-image")) && field === document.activeElement;
  }),
  "the picture went away, or the field never took focus",
);
// The field sits inside a block that does not take the pointer, so it has
// to ask for it back: without that the caret cannot be placed by clicking.
check(
  "and the field can still be clicked into",
  await page.evaluate(() => {
    const field = document.querySelectorAll(".shape-node")[1].querySelector(".node-rename");
    return field ? getComputedStyle(field).pointerEvents !== "none" : false;
  }),
  "the field was not clickable",
);

// Shift+Enter is the line break, Enter still ends the rename, and the file
// gets the one spelling mermaid understands. Checked on the unframed node
// because it is the one a second line can resize — the field has to grow by
// exactly the height of the line it gained and no more.
await page.keyboard.press("Control+a");
await page.keyboard.type("First");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("Second");
await page.waitForTimeout(300);
check(
  "Shift+Enter makes a line instead of ending the rename",
  (await page.locator(".node-rename").count()) === 1,
  "the rename ended on Shift+Enter",
);
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
const named = await page.evaluate(() => {
  const node = document.querySelectorAll(".shape-node")[1] as HTMLElement;
  return {
    label: (
      window as unknown as {
        __graphTest: { store: { getState(): { nodes: Array<{ data: { label: string } }> } } };
      }
    ).__graphTest.store.getState().nodes[1].data.label,
    drawn: node.querySelector(".shape-label")!.textContent,
  };
});
check(
  "Enter still ends it, and the second line is written as <br>",
  named.label === "First<br>Second",
  `the label reads ${JSON.stringify(named.label)}`,
);
check(
  "which the canvas draws as two lines rather than as markup",
  !named.drawn?.includes("<br>"),
  `the node says ${JSON.stringify(named.drawn)}`,
);

// And re-opening shows the lines, not the markup that holds them — at the
// size the two lines already take, since a field one row taller than its
// text is a node that grows the moment it is opened.
const atRest = await box();
await page.locator(".shape-node").nth(1).dblclick();
await page.waitForTimeout(400);
check(
  "and re-opening the field shows lines, not markup",
  (await page.locator(".node-rename").inputValue()) === "First\nSecond",
  JSON.stringify(await page.locator(".node-rename").inputValue()),
);
check(
  "and a two-line node is not resized by editing it either",
  (await box()).size === atRest.size,
  `${atRest.size} at rest became ${(await box()).size} while renaming`,
);

await look.selectOption("boxed");
await page.waitForTimeout(700);
check(
  "and the frame can be put back",
  (await styles()).length === 0,
  JSON.stringify(await styles()),
);

// Deliberately after putting it back by hand: an edit to the node must not
// take the frame off again behind the user.
await setUrl("https://api.iconify.design/logos/aws.svg");
check(
  "changing the picture leaves that decision alone",
  (await styles()).length === 0,
  JSON.stringify(await styles()),
);

await setUrl("");
check(
  "and clearing the picture leaves no invisible node behind",
  !(await styles()).includes("fill:none"),
  JSON.stringify(await styles()),
);

/* ---------- vendor icons in a flowchart ---------- */

// The palette's icons, which used to be architecture's alone, put into a
// flowchart as pictures with their names under them.
await page.goto(codeUrl('flowchart TD\n  s["Start"] --> w["Next step"]\n'));
await page.waitForSelector(".react-flow__node");
await page.waitForTimeout(1000);
const nodesBefore = (await nodes()).length;
await page.locator(".palette .icon-search").fill("kubernetes");
// One the search found, not one of the suggestions shown before it answers.
const iconCell = page.locator(`.palette .icon-grid .icon-add[title*="kubernetes" i]`).first();
await iconCell.waitFor({ timeout: 10000 });
await iconCell.click();
await page.waitForFunction(
  (n) =>
    (
      window as unknown as { __graphTest: { store: { getState(): { nodes: unknown[] } } } }
    ).__graphTest.store.getState().nodes.length ===
    n + 1,
  nodesBefore,
  { timeout: 10000 },
);
const added = (await nodes()).at(-1) as unknown as {
  type: string;
  data: { img?: string; label?: string; imgWidth?: number };
};
check(
  "a flowchart takes an icon from the palette, as a picture",
  added.type === "shape" && (added.data.img ?? "").startsWith("data:image/svg+xml;base64,"),
  JSON.stringify({ type: added.type, img: added.data.img?.slice(0, 40) }),
);
check(
  "with its name under it",
  /kubernetes/i.test(added.data.label ?? ""),
  `label "${added.data.label}"`,
);
const drawn = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll<HTMLImageElement>(".react-flow__node img")];
  const last = imgs.at(-1);
  return last ? { w: last.naturalWidth, complete: last.complete } : null;
});
check("and the picture draws", !!drawn && drawn.complete && drawn.w > 0, JSON.stringify(drawn));

check("nothing threw", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failed ? "\nicon picking FAILED" : "\npicking an icon picks it");
process.exit(failed ? 1 : 0);
