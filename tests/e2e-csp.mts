/**
 * Browser-driven security regression test: diagram source is untrusted, and
 * two independent layers have to keep it inert.
 *
 * Diagram code reaches the app from a `?code=` link, from the embed bridge's
 * `load` message and from opened .mmd files. `MermaidPreview` then writes the
 * rendered SVG into the DOM with `innerHTML`, so anything that survives as
 * live markup is an XSS vector — and `?code=` makes it a one-click one.
 *
 * The two layers, checked separately on purpose:
 *
 *   1. **mermaid's sanitizer** (`securityLevel: "strict"` in
 *      `src/model/fromMermaid.ts`). Checked with `bypassCSP: true`, so the
 *      CSP cannot mask a regression here. This is the layer that must hold
 *      on its own: the CSP lives in a `<meta>` tag that a self-hoster can
 *      drop or a proxy can rewrite.
 *   2. **the Content Security Policy** in `index.html`. Checked with CSP
 *      enforced, by trying to run an inline script.
 *
 * The load-bearing assertion is the `click … href` one. mermaid runs DOMPurify
 * over labels at *every* security level, so a label-only test passes just as
 * happily under "loose" and proves nothing. `utils.formatUrl` is the code path
 * that actually branches on the level: it only calls `sanitizeUrl` when the
 * level is not "loose". Flipping `fromMermaid.ts` to "loose" must make this
 * suite fail — if it doesn't, the suite is decoration.
 *
 * Every assertion is paired with a positive control, so nothing can pass
 * because the diagram failed to render at all.
 *
 * Run:  npm run build && npm run preview, then
 *       ARCHYNE_URL=http://localhost:4173 npx tsx tests/e2e-csp.mts
 */
import { chromium, type Browser, type Page } from "playwright";
import { BASE, CHANNEL, codeUrl } from "./env.mts";

/**
 * The real strict-vs-loose discriminator. `click … href` targets go through
 * `utils.formatUrl`, which sanitizes only outside "loose" mode. The second
 * link is the positive control: it must survive, or the first check would
 * pass on a diagram that rendered no anchors at all.
 */
const HOSTILE_LINKS = `flowchart TD
  a["report"] --> b["docs"]
  click a href "javascript:window.__pwned = 1" "run it"
  click b href "https://example.com/docs" "safe link"
`;

/**
 * Labels carrying an event handler, an inline <script> and a javascript: URL.
 * mermaid sanitizes these regardless of security level, so this pins DOMPurify
 * staying wired up at all — it is not evidence for `strict`.
 */
const HOSTILE_LABELS = `flowchart TD
  a["<img src=x onerror='window.__pwned = 1'>"] --> b["<script>window.__pwned = 2</script>"]
  b --> c["<a href='javascript:window.__pwned=3'>click me</a>"]
  c --> d["harmless"]
`;

/** `<br/>` is the one HTML tag Mermaid diagrams legitimately use in labels. */
const BREAKS = `flowchart TD
  a["Start <br/> second line"] --> b{"Valid?"}
`;

/** Renders through the same MermaidPreview path, with icons in play. */
const BENIGN = `architecture-beta
  group g1(cloud)[VPC]
  service web(internet)[Web] in g1
  service db(database)[Database] in g1
  web:R -[query]-> L:db
`;

let failed = false;
function check(ok: boolean, label: string, detail?: string) {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed = true;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

/** Load a diagram and switch to the Preview tab, where mermaid renders it. */
async function openPreview(page: Page, code: string) {
  await page.goto(codeUrl(code));
  await page.getByRole("tab", { name: "Preview" }).click();
  // mermaid loads lazily (~2 MB) and renders async; wait for ink, not a timer.
  await page.waitForSelector("#panel-preview svg", { timeout: 30000 });
  await page.waitForTimeout(500);
}

/**
 * Every link target in the preview. mermaid emits SVG anchors with
 * `xlink:href`, and drops the attribute entirely when the target did not
 * survive sanitizing — so read both names off the elements rather than
 * selecting on the attribute.
 */
async function previewHrefs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("#panel-preview a")].map(
      (el) => el.getAttribute("xlink:href") ?? el.getAttribute("href") ?? "",
    ),
  );
}

const browser: Browser = await chromium.launch({ channel: CHANNEL, headless: true });
try {
  // ---- Layer 1a: click/href targets are sanitized. This is the check that
  // distinguishes "strict" from "loose"; the rest of layer 1 does not.
  {
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await openPreview(page, HOSTILE_LINKS);
    const hrefs = await previewHrefs(page);

    // Positive control first: if links do not render at all, the negative
    // below is vacuous and the whole block is worthless.
    check(
      hrefs.some((h) => h.startsWith("https://example.com/docs")),
      "positive control — a benign click/href link still renders",
      `hrefs = ${JSON.stringify(hrefs)}`,
    );
    check(
      !hrefs.some((h) => /^\s*javascript:/i.test(h)),
      "javascript: click target rewritten by sanitizeUrl",
      `hrefs = ${JSON.stringify(hrefs)}`,
    );

    // And it stays inert when actually activated, not just in the markup.
    const hostile = page.locator("#panel-preview a", { hasText: "report" }).first();
    if (await hostile.count())
      await hostile.click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const pwnedByLink = await page.evaluate(
      () => (window as unknown as { __pwned?: unknown }).__pwned,
    );
    check(
      pwnedByLink === undefined,
      "clicking the sanitized link executes nothing",
      `__pwned = ${String(pwnedByLink)}`,
    );
    check(dialogs.length === 0, "no dialog raised from click targets", dialogs.join(" | "));

    await context.close();
  }

  // ---- Layer 1b: labels stay inert. True at every security level — this
  // pins that mermaid's DOMPurify pass is wired up at all, nothing more.
  {
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await openPreview(page, HOSTILE_LABELS);

    const pwned = await page.evaluate(
      () => (window as unknown as { __pwned?: unknown }).__pwned,
    );
    check(
      pwned === undefined,
      "no script executed from diagram labels",
      `__pwned = ${String(pwned)}`,
    );
    check(dialogs.length === 0, "no dialog raised from diagram labels", dialogs.join(" | "));

    const html = (await page.locator("#panel-preview").innerHTML()) ?? "";
    check(!/onerror\s*=/i.test(html), "onerror handler stripped from rendered SVG");
    check(!/<script/i.test(html), "<script> stripped from rendered SVG");
    check(!/javascript:/i.test(html), "javascript: URL stripped from rendered SVG");
    check(html.includes("harmless"), "positive control — the hostile diagram still rendered");

    await context.close();
  }

  // ---- Layer 1 control: a legitimate diagram is unharmed by strict mode.
  //
  // Sanitizing is only free if it costs nothing on real diagrams, so this
  // pins the two things a label sanitizer could plausibly break: the vendor
  // icons (inlined by mermaid as nested <svg>, not <img>) and `<br/>`, the
  // one HTML tag Mermaid authors genuinely rely on.
  {
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    await openPreview(page, BENIGN);
    const html = await page.locator("#panel-preview").innerHTML();
    check(
      html.includes("Web") && html.includes("Database"),
      "benign labels survive sanitizing",
    );
    // One root <svg> plus one per icon (cloud, internet, database).
    const svgCount = (html.match(/<svg/gi) ?? []).length;
    check(svgCount >= 4, "architecture icons still render", `nested <svg> count = ${svgCount}`);

    await openPreview(page, BREAKS);
    const label = page.locator("#panel-preview .nodeLabel").first();
    const labelHtml = await label.innerHTML();
    check(/<br\s*\/?>/i.test(labelHtml), "<br/> survives sanitizing", labelHtml);
    // Two rendered lines, not one — proves the <br> is laid out, not just present.
    const height = (await label.boundingBox())?.height ?? 0;
    check(height > 36, "<br/> still breaks the line", `label height = ${height}px`);
    await context.close();
  }

  // ---- Layer 2: the CSP is actually enforced, not just present in the markup.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto(BASE);
    await page.waitForSelector(".app", { timeout: 30000 });

    const ran = await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__inlineRan = true";
      document.body.appendChild(s);
      return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;
    });
    check(!ran, "CSP blocks an injected inline script");
    check(violations.length > 0, "the block was reported as a CSP violation");

    const policy = await page.evaluate(
      () =>
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
    );
    check(/script-src\s+'self'/.test(policy), "policy still pins script-src to 'self'");
    // The narrow 'wasm-unsafe-eval' token is fine — it admits only
    // WebAssembly compilation, for onnxruntime-web — but bare 'unsafe-eval',
    // which lets any string run as code, is what must stay out.
    check(!/(?<!-)unsafe-eval/.test(policy), "policy does not allow unsafe-eval");
    check(!/script-src[^;]*unsafe-inline/.test(policy), "policy does not allow inline script");

    await context.close();
  }
} finally {
  await browser.close();
}

console.log(failed ? "\nsecurity checks FAILED" : "\nall security checks passed");
process.exit(failed ? 1 : 0);
