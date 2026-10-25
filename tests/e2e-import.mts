/**
 * E2E: open real foreign files through the app's own file input and check
 * what lands on the canvas.
 *
 * The conversions have unit tests; this covers the part they cannot — that a
 * file goes in through the interface, comes out as an editable Mermaid
 * document bound to nothing, and renders. The images it saves are there to be
 * looked at beside the originals.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-import.mts [output-prefix]
 */
import { chromium, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { CHANNEL, BASE } from "./env.mts";

const PREFIX = (process.argv[2] ?? "import-e2e").replace(/\.png$/, "");
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

interface TestApi {
  ready: () => boolean;
  state: () => { kind: string; nodes: number; edges: number; parseError: string | null };
  store: { getState: () => { code: string } };
  files: {
    getState: () => { name: string | null; path: string | null; savedCode: string | null };
  };
  workspace: {
    getState: () => { docs: Array<{ id: string; name: string }>; activeId: string };
  };
}

declare global {
  // Only inside `page.evaluate`, whose body runs in the browser rather than
  // here — so the helper cannot be a closure and has to be declared instead.
  const __graphTest: TestApi;
}

let failures = 0;
function check(what: string, ok: boolean) {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
}

/**
 * Import one file: choose it, check the preview, accept it, wait for it.
 *
 * The preview is the point of this helper. A conversion is shown before it
 * lands, so the assertion that matters is not only that the diagram arrives
 * but that it has *not* arrived while the dialog is still up.
 *
 * Waiting on the document's *name* rather than on a node count: the sample
 * diagram is already on screen, and counting would match it and read the
 * wrong graph.
 */
async function open(page: Page, file: string, expected: string, canvas = true) {
  await page.setInputFiles('input[type="file"]', fixture(file));
  await page.locator(".modal").waitFor({ timeout: 30000 });

  if (canvas) {
    // The preview opens on the Archyne canvas — the one the diagram will
    // actually be edited on — so a rendered node is the signal it is ready.
    await page.locator(".import-canvas .react-flow__node").first().waitFor({ timeout: 30000 });
    // Connections are the part that silently vanished twice: the editor's own
    // edge components read the live store, and React Flow drops an edge whose
    // handle it cannot resolve. Both failures looked like boxes and no arrows.
    //
    // Waited for, not counted on the spot: React Flow draws an edge only once
    // both its ends have been measured, a beat after the first node shows —
    // longer for a bigger diagram on a busy machine, which is how the Lucid
    // preview came out with "no connections" on the CI runner now and then.
    const edges = page.locator(".import-canvas .react-flow__edge");
    await edges
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => {});
    const drawn = await edges.count();
    check(`${file}: the preview draws the connections, not just the boxes`, drawn > 0);
    // And draws them with the editor's own router, not a stand-in: the class
    // React Flow puts on an edge is its type, so `routed` means the real
    // component resolved the graph it was handed.
    const routed = await page
      .locator(
        ".import-canvas .react-flow__edge-routed, .import-canvas .react-flow__edge-parallel",
      )
      .count();
    check(`${file}: the connections are routed by the editor's own component`, routed > 0);
  } else {
    // A sequence diagram opens on the Mermaid rendering instead: its rows
    // come from the message order, which the canvas cannot lay out.
    await page.locator(".import-render svg").first().waitFor({ timeout: 30000 });
    check(`${file}: the preview falls back to the rendering it can draw`, true);
    // Fit means *fill*: Mermaid writes `width="100%"` with a pixel max-width,
    // which collapses inside a shrink-to-fit box, and the picture arrived a
    // fraction of its size in the middle of an empty pane.
    const filled = await page.evaluate(() => {
      const host = document.querySelector(".panzoom")!.getBoundingClientRect();
      const drawn = document.querySelector(".panzoom-content")!.getBoundingClientRect();
      return Math.max(drawn.width / host.width, drawn.height / host.height);
    });
    check(
      `${file}: the rendering fills the pane it is fitted to (${filled.toFixed(2)})`,
      filled > 0.8,
    );

    // Both panes are the same instrument: the rendering pans and zooms the
    // way the canvas does, rather than being a fixed picture in a scroll box.
    const before = await page.locator(".panzoom-content").getAttribute("style");
    const box = (await page.locator(".panzoom").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
    const after = await page.locator(".panzoom-content").getAttribute("style");
    check(`${file}: the rendering zooms under the pointer`, before !== after);

    // And by the buttons. They sit inside the pane, so a press on one bubbles
    // to the pan handler — which captured the pointer and swallowed the click.
    // The gestures worked while the three buttons did nothing at all.
    const style = () => page.locator(".panzoom-content").getAttribute("style");
    const control = (i: number) => page.locator(".panzoom-controls button").nth(i);
    await control(2).click(); // fit
    await page.waitForTimeout(250);
    const fitted = await style();
    await control(0).click(); // in
    await page.waitForTimeout(250);
    const zoomedIn = await style();
    await control(1).click(); // out
    await page.waitForTimeout(250);
    check(`${file}: the zoom buttons work, not just the wheel`, fitted !== zoomedIn);
    check(`${file}: zooming back out returns it`, (await style()) === fitted);
  }
  const landedEarly = await page.evaluate(
    (name) => __graphTest.files.getState().name === name,
    expected,
  );
  check(`${file}: nothing is imported until the preview is accepted`, !landedEarly);

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.waitForFunction((name) => __graphTest.files.getState().name === name, expected, {
    timeout: 30000,
  });
  await page.waitForTimeout(600); // icons and fonts settle
  return {
    state: await page.evaluate(() => __graphTest.state()),
    code: await page.evaluate(() => __graphTest.store.getState().code),
    file: await page.evaluate(() => __graphTest.files.getState()),
  };
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[console]", m.text());
  });
  await page.goto(BASE);
  // The sample diagram loads asynchronously; opening a file before it lands
  // would be undone by it.
  await page.waitForFunction(
    () => (window as unknown as { __graphTest?: TestApi }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );

  console.log("\ndraw.io");
  {
    const { state, code, file } = await open(page, "order-flow.drawio", "order-flow.mmd");
    const has = (needle: string) => code.includes(needle);

    check("it opened as an editable flowchart", state.kind === "flowchart");
    check("nothing failed to parse", state.parseError === null);
    // Seven shapes — six boxes and a heading — inside one container.
    check(`all eight cells arrived (got ${state.nodes})`, state.nodes === 8);
    check(`every connection arrived (got ${state.edges})`, state.edges === 5);
    check("the container became a subgraph", has("subgraph Checkout"));
    check("the decision kept its shape", has("Card_valid{"));
    check("the database kept its shape", has("Orders[("));
    check("the stencil became a subroutine", has("Audit_log[["));
    check("the dashed connection stayed dashed", has("-.->"));
    check("the thick one stayed thick", has("==>"));
    check("the arrowless one stayed arrowless", has("Orders --- Audit_log"));
    check("edge labels came off their own cells", has('|"yes"|') && has('|"no"|'));
    check("pale fills got readable text", has("fill:#d5e8d4,stroke:#82b366,color:#111111"));
    check("the layout came across", has("%% graph:positions"));
    check("the hand-routed corners came across", has("%% graph:waypoints"));
    check("it is not bound to the .drawio it came from", file.path === null);
    // Never written anywhere, so closing the tab has to warn rather than
    // treat it as a clean copy of a file on disk.
    check("it counts as unsaved work", file.savedCode === null);

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-drawio.png` });
  }

  console.log("\ndraw.io, a file of several pages");
  {
    // An overview and its details: only the first page could ever be
    // imported, and the dialog said so instead of letting it be chosen.
    await page.setInputFiles('input[type="file"]', fixture("two-pages.drawio"));
    await page.locator(".modal").waitFor({ timeout: 30000 });
    // The select named "Page", not the "Pages to import" list beside it.
    const pageSelect = page.getByRole("combobox", { name: /^Page(?!s)/ });
    check("the dialog offers the pages to choose from", (await pageSelect.count()) === 1);
    const options = await pageSelect.locator("option").allTextContents();
    check(
      `both pages are named (got ${options.join(", ")})`,
      options.join("|") === "Overview|Details",
    );
    await pageSelect.selectOption({ label: "Details" });
    await page
      .locator(".import-canvas .react-flow__node", { hasText: "Detail one" })
      .waitFor({ timeout: 30000 });
    check("the preview shows the page chosen", true);
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.waitForFunction(
      () => __graphTest.files.getState().name === "two-pages.mmd",
      null,
      {
        timeout: 30000,
      },
    );
    const code = await page.evaluate(() => __graphTest.store.getState().code);
    check(
      "the page chosen is the one imported",
      code.includes("Detail one") && !code.includes("Front door"),
    );
  }

  console.log("\ndraw.io, every page at once");
  {
    // One page per pass through the dialog was the only way to bring over an
    // overview and its details.
    const before = await page.evaluate(() => __graphTest.workspace.getState().docs.length);
    await page.setInputFiles('input[type="file"]', fixture("two-pages.drawio"));
    await page.locator(".modal").waitFor({ timeout: 30000 });
    await page.getByLabel("All pages").check();
    await page.getByRole("button", { name: "Import 2 pages", exact: true }).click();
    await page.locator(".modal").waitFor({ state: "detached", timeout: 30000 });
    const docs = await page.evaluate(() =>
      __graphTest.workspace.getState().docs.map((d) => d.name),
    );
    const added = docs.slice(before);
    check(
      `each page opens in a tab of its own (got ${added.join(", ")})`,
      added.join("|") === "two-pages - Overview.mmd|two-pages - Details.mmd",
    );
    const code = await page.evaluate(() => __graphTest.store.getState().code);
    check("the last page is the one on show", code.includes("Detail one"));
  }

  console.log("\ndraw.io, forty pages");
  {
    // A row per page with nothing to stop it ran the list out of the dialog.
    const diagram = (i: number) =>
      `<diagram name="Region ${i} with a name long enough to need wrapping" id="p${i}"><mxGraphModel><root>` +
      `<mxCell id="0"/><mxCell id="1" parent="0"/>` +
      `<mxCell id="n${i}" value="Box ${i}" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>` +
      `</root></mxGraphModel></diagram>`;
    const xml = `<mxfile>${Array.from({ length: 40 }, (_, i) => diagram(i + 1)).join("")}</mxfile>`;
    await page.setInputFiles('input[type="file"]', {
      name: "forty-pages.drawio",
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    const modal = page.locator(".modal");
    await modal.waitFor({ timeout: 30000 });
    const list = page.locator(".import-page-list");
    const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    check("the page list scrolls in a box of its own", scrolls);
    const viewport = page.viewportSize()!;
    const box = (await modal.boundingBox())!;
    check(
      `the dialog stays inside the window (bottom ${Math.round(box.y + box.height)} of ${viewport.height})`,
      box.y + box.height <= viewport.height,
    );
    const column = page.locator(".import-modal .export-opts");
    const width = await column.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    check(`a long page name wraps (${width[0]} wide in ${width[1]})`, width[0] <= width[1]);
    await page.getByRole("checkbox", { name: /^Region 3 with/ }).check();
    await page.getByRole("checkbox", { name: /^Region 37 with/ }).check();
    const partial = await page
      .getByLabel("All pages")
      .evaluate((el) => (el as HTMLInputElement).indeterminate);
    check("a partial choice shows on the all-pages tick", partial);
    const overlap = await list.evaluate((el) => {
      const rows = [...el.querySelectorAll("label")].map((r) => r.getBoundingClientRect());
      return rows.some((r, i) => i > 0 && r.top < rows[i - 1].bottom - 0.5);
    });
    check("a wrapped name does not run into the next row", !overlap);
    await modal.screenshot({ path: `${PREFIX}-many-pages.png` });
    check(
      "the button counts the choice",
      await page.getByRole("button", { name: "Import 3 pages", exact: true }).isVisible(),
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await modal.waitFor({ state: "detached", timeout: 30000 });
  }

  console.log("\nGraphviz");
  {
    const { state, code, file } = await open(page, "services.gv", "services.mmd");
    const has = (needle: string) => code.includes(needle);

    check("it opened as an editable flowchart", state.kind === "flowchart");
    check("nothing failed to parse", state.parseError === null);
    // Eight nodes and three clusters.
    check(`every node and cluster arrived (got ${state.nodes})`, state.nodes === 11);
    // Nine written, one of them a repeat that `strict` forbids.
    check(`the repeat "strict" forbids was dropped (got ${state.edges})`, state.edges === 8);
    check("rankdir became the direction", has("flowchart LR"));
    check("clusters nested", /subgraph Core_services[\s\S]*subgraph API/.test(code));
    check("a plain subgraph did not become a container", !has("subgraph services"));
    check("shapes survived the block defaults", has("CDN([") && has("Gateway{{"));
    check("a node's own fill beat the default", has("style Auth fill:#d5e8d4"));
    check(
      "the braced fan-out became two edges",
      has("Gateway --> Postgres") && has("Gateway --> Queue"),
    );
    check("dir=both became a two-headed arrow", has("Worker <--> Queue"));
    check("a dashed edge kept its label", has('Worker -.->|"read only"| Postgres'));
    check("a graph with no coordinates is left to be laid out", !has("%% graph:positions"));
    check("it is named as Mermaid", file.name === "services.mmd");
    check("it is not bound to the .gv it came from", file.path === null);

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-dot.png` });
  }

  console.log("\nSQL");
  {
    const { state, code, file } = await open(page, "shop.sql", "shop.mmd");
    const has = (needle: string) => code.includes(needle);

    // A different diagram family altogether, which is the point of this one:
    // the editor has to switch kind, not just content.
    check("it opened as an editable ER diagram", state.kind === "er");
    check("nothing failed to parse", state.parseError === null);
    check(`every table arrived (got ${state.nodes})`, state.nodes === 3);
    check(`every foreign key arrived (got ${state.edges})`, state.edges === 2);
    check("the schema qualifier came off the names", has("customers {") && !has("public_"));
    check("keys are marked", has("bigint id PK") && has("bigint customer_id FK"));
    check("a single-column unique is marked", has("email UK"));
    check("a multi-word type stayed one token", has("character_varying(255)"));
    check("a comment came across", has('"including tax"'));
    check("it is named as Mermaid", file.name === "shop.mmd");

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-sql.png` });
  }

  console.log("\nPlantUML");
  {
    const { state, code } = await open(page, "login.puml", "login.mmd", false);
    const has = (needle: string) => code.includes(needle);

    check("it opened as an editable sequence diagram", state.kind === "sequence");
    check("nothing failed to parse", state.parseError === null);
    check(`every participant arrived (got ${state.nodes})`, state.nodes === 3);
    check(`every message arrived (got ${state.edges})`, state.edges === 5);
    check("an actor stayed an actor", has("actor User"));
    check("an alias became the label", has("participant Web_app as Web app"));
    check("a solid arrow kept its head", has("User->>Web_app: GET /login"));
    check("alt and else came across", has("alt cached") && has("else miss"));
    check("activation came across", has("activate Web_app"));
    check("the note came across", has("Note right of DB: read replica"));
    check("styling did not", !has("skinparam") && !has("!theme"));

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-plantuml.png` });
  }

  console.log("\nVisio");
  {
    // The only binary format, so this is the one that proves the bytes reach
    // the importer intact rather than as UTF-8 that has destroyed them.
    const { state, code, file } = await open(page, "order-process.vsdx", "order-process.mmd");
    const has = (needle: string) => code.includes(needle);

    check("it opened as an editable flowchart", state.kind === "flowchart");
    check("nothing failed to parse", state.parseError === null);
    check(`every shape arrived (got ${state.nodes})`, state.nodes === 4);
    check(`every connector arrived (got ${state.edges})`, state.edges === 2);
    check("masters became shapes", has("In_stock{") && has("Backorder[("));
    check("the Connects table became edges", has('Receive_order -->|"yes"| In_stock'));
    check("a literal fill came across", has("style Ship_it fill:#d5e8d4"));
    check("the inch geometry came across", has("%% graph:positions"));
    check("it is not bound to the .vsdx it came from", file.path === null);

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-vsdx.png` });
  }

  console.log("\nLucidchart");
  {
    // A zip, like Visio — so this is a second format proving the bytes reach
    // the importer intact rather than as UTF-8 that has destroyed them.
    const { state, code, file } = await open(page, "order-flow.lucid", "order-flow.mmd");
    const has = (needle: string) => code.includes(needle);

    check("it opened as an editable flowchart", state.kind === "flowchart");
    check("nothing failed to parse", state.parseError === null);
    check(`every shape arrived (got ${state.nodes})`, state.nodes === 5);
    check(`every connector arrived (got ${state.edges})`, state.edges === 4);
    check("the decision kept its shape", has("In_stock{"));
    check("the database kept its shape", has("Backorder[("));
    check("the terminator became a stadium", has('Receive_order(["Receive order"])'));
    check("edge labels came off their own lines", has('In_stock -->|"yes"| Ship_it'));
    check("the dashed elbow stayed dashed", has('In_stock -.->|"no"| Backorder'));
    check("the arrowless one stayed arrowless", has("Ship_it --- Backorder"));
    check("a chosen fill got readable text", has("style Backorder fill:#dae8fc,color:#111111"));
    check("the layout came across", has("%% graph:positions"));
    check("the hand-routed corners came across", has("%% graph:waypoints"));
    check("it is named as Mermaid", file.name === "order-flow.mmd");
    check("it is not bound to the .lucid it came from", file.path === null);
    check("it counts as unsaved work", file.savedCode === null);

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-lucid.png` });
  }

  console.log("\ndraw.io, forced to architecture");
  {
    // A real file somebody brought: nested swimlanes, twenty connections, no
    // vendor stencils. The architecture family has no coordinates of its own,
    // so this is where a preserved layout either holds together or collapses
    // into a pile of overlapping boxes.
    await page.setInputFiles('input[type="file"]', fixture("vpc-swimlanes.drawio"));
    await page.locator(".import-canvas .react-flow__node").first().waitFor({ timeout: 30000 });
    await page.locator(".export-opts select").selectOption("architecture");
    // Until the services are all there, rather than a fixed pause that a slow
    // machine outlasts; then a moment for the layout to settle.
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll(".import-canvas .react-flow__node-service").length >= 19,
        undefined,
        { timeout: 30000 },
      )
      .catch(() => {});
    await page.waitForTimeout(500);

    const { services, overlaps } = await page.evaluate(() => {
      const boxes = [
        ...document.querySelectorAll(".import-canvas .react-flow__node-service"),
      ].map((n) => n.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const c = boxes[j];
          if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) {
            overlaps++;
          }
        }
      }
      return { services: boxes.length, overlaps };
    });
    check(`the architecture layout drew every service (got ${services})`, services === 19);
    check(`no two of them sit on top of each other (${overlaps})`, overlaps === 0);

    await page
      .locator(".react-flow")
      .first()
      .screenshot({ path: `${PREFIX}-vpc.png` });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(400);
  }

  console.log("\ndraw.io, as cloud architecture");
  {
    // The same importer, a different family: an AWS drawing has icons, and a
    // flowchart has nowhere to put them.
    const { state, code } = await open(page, "cloud-aws.drawio", "cloud-aws.mmd");
    const has = (needle: string) => code.includes(needle);

    check("it opened as an editable architecture diagram", state.kind === "architecture");
    check("nothing failed to parse", state.parseError === null);
    check(`every shape arrived (got ${state.nodes})`, state.nodes === 12);
    check(`every connection arrived (got ${state.edges})`, state.edges === 10);
    check("the VPC became a group", has("group amazon_vpc(cloud)[Amazon VPC]"));
    check(
      "stencils became vendor icons",
      has("(logos:aws-elb)") && has("(logos:aws-api-gateway)"),
    );
    check("a label the grammar rejects was cleaned", !has("10.0.0.0/16") && !has("Utente /"));
    check(
      "connections are anchored by relative position",
      has(":B --> T:") && has(":R --> L:"),
    );

    await page.locator(".react-flow").screenshot({ path: `${PREFIX}-aws.png` });
  }

  console.log(`\nsaved ${PREFIX}-*.png`);
  if (failures) throw new Error(`${failures} check(s) failed`);
} finally {
  await browser.close();
}
