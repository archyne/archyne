/**
 * Does `measureNode` predict what the browser actually does?
 *
 * Everything else in the renderer plan rests on this one claim. Parsing is
 * Mermaid's and already runs headless; layout is ELK's and already runs
 * headless; but the size of a node is computed by a browser laying out CSS, and
 * `src/measureNode.ts` has to arrive at the same number without one. The
 * constants it works from are copied out of `src/styles.css` by hand, and a
 * copied constant is wrong the moment somebody edits the original.
 *
 * So both answers are asked for in the one place where both exist. The page
 * reports, per node, what `measureNode` predicted and what React Flow measured
 * after the browser laid it out; this compares them.
 *
 * Nodes that carry a size of their own are skipped: their box is whatever was
 * typed, so agreeing about it proves nothing. Groups are skipped for the same
 * reason — layout sizes them from their children.
 *
 * A sequence participant is compared on width only. Its element is a head *and
 * a lifeline*, and the lifeline's length is a property of the diagram — how
 * many messages it has to reach past — rather than of the node. `measureNode`
 * answers for the head, which is the part layout places; asking it to predict
 * the lifeline would be asking it to predict the message list.
 *
 * Run:  npm run dev, then npx tsx tests/e2e-measure.mts
 */
import { chromium, type Page } from "playwright";
import { CHANNEL, codeUrl } from "./env.mts";

/**
 * How far apart the two may be before it counts as a disagreement.
 *
 * Not zero, and it should not be: `line-height: normal` resolves through the
 * font's own metrics, the browser lays out at sub-pixel precision and reports
 * rounded, and a stack that falls back to a different face on a different
 * machine measures differently. What the tolerance is for is the difference
 * between *that* and a constant somebody changed in one file and not the other.
 */
const TOLERANCE = 4;

interface Measured {
  id: string;
  type: string;
  sized: boolean;
  predicted: { width: number; height: number };
  actual: { width: number; height: number };
}

const CORPUS: Record<string, string> = {
  flowchart: `flowchart TD
  a["Start"]
  b["A rather longer label, to make the box grow"]
  c{"Valid?"}
  d[("Database")]
  e(("Done"))
  a --> b --> c --> d --> e
`,
  state: `stateDiagram-v2
  [*] --> Idle
  Idle --> AwaitingDownstreamConfirmation : start
  AwaitingDownstreamConfirmation --> [*]
`,
  er: `erDiagram
  CUSTOMER {
    string name PK
    timestamptz last_authenticated_at
    int id
  }
  ORDER {
    int id PK
  }
  CUSTOMER ||--o{ ORDER : "places"
`,
  class: `classDiagram
  class Account {
    +int id
    +String holderName
    +authenticateWithProvider(provider) Session
    +close() void
  }
  class Ledger {
    +int id
  }
  Account <|-- Ledger
`,
  sequence: `sequenceDiagram
  actor U as A user with a long name
  participant S as Server
  U->>S: request
  S-->>U: response
`,
  architecture: `architecture-beta
  group vpc(cloud)[VPC]
  service web(internet)[Web front end] in vpc
  service db(database)[Db] in vpc
  web:R --> L:db
`,
  c4: `C4Context
  title System Context
  Person(user, "A person with a long name")
  System(app, "Application", "Does the thing this system exists to do")
  Rel(user, app, "Uses")
`,
  requirement: `requirementDiagram
  functionalRequirement brake {
    id: "R-2"
    text: "The vehicle shall stop within 40 m from 100 km/h on a dry road."
    risk: high
    verifymethod: test
  }
  element brake_system {
    type: "block"
  }
  designConstraint mass {
  }
  brake_system - satisfies -> brake
  brake - contains -> mass
`,
};

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
const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

async function measure(code: string): Promise<Measured[]> {
  await page.goto(codeUrl(code));
  await page.waitForFunction(
    () => (window as unknown as { __graphTest?: { ready(): boolean } }).__graphTest?.ready(),
    undefined,
    { timeout: 30000 },
  );
  // `ready()` waits for every node to have been measured; layout still moves
  // them once afterwards, and a node re-measured mid-read would be read twice.
  await page.waitForTimeout(800);
  return page.evaluate(() =>
    (window as unknown as { __graphTest: { measured(): Measured[] } }).__graphTest.measured(),
  );
}

/** Whether this node's height is the node's own business — see the header. */
const heightIsIntrinsic = (n: Measured) => n.type !== "participant";

/** The worst disagreement in a set, and which node it was. */
function worst(nodes: Measured[]) {
  let width = { by: 0, id: "", detail: "" };
  let height = { by: 0, id: "", detail: "" };
  for (const n of nodes) {
    const dw = Math.abs(n.predicted.width - n.actual.width);
    const dh = heightIsIntrinsic(n) ? Math.abs(n.predicted.height - n.actual.height) : 0;
    if (dw > width.by) {
      width = {
        by: dw,
        id: n.id,
        detail: `${n.type} "${n.id}": predicted ${n.predicted.width}, measured ${n.actual.width}`,
      };
    }
    if (dh > height.by) {
      height = {
        by: dh,
        id: n.id,
        detail: `${n.type} "${n.id}": predicted ${n.predicted.height}, measured ${n.actual.height}`,
      };
    }
  }
  return { width, height };
}

for (const [family, code] of Object.entries(CORPUS)) {
  const all = await measure(code);
  const nodes = all.filter((n) => !n.sized && n.type !== "group");

  if (nodes.length === 0) {
    check(`${family} has nodes to compare`, false, "every node was sized or a group");
    continue;
  }

  // Printed whatever the outcome: when this drifts, the number is the finding,
  // and a pass that says only "✓" hides how much room is left before it fails.
  for (const n of nodes) {
    const dw = n.predicted.width - n.actual.width;
    const intrinsic = heightIsIntrinsic(n);
    const dh = n.predicted.height - n.actual.height;
    const worstOf = Math.max(Math.abs(dw), intrinsic ? Math.abs(dh) : 0);
    const sign = (v: number) => `${v >= 0 ? "+" : ""}${v}`;
    console.log(
      `    ${family}/${n.id} (${n.type}): ` +
        `${n.predicted.width}×${n.predicted.height} vs ${n.actual.width}×${n.actual.height} ` +
        `(${sign(dw)}, ${intrinsic ? sign(dh) : "lifeline"})` +
        `${worstOf > TOLERANCE ? " ←" : ""}`,
    );
  }

  const off = worst(nodes);
  check(
    `${family}: every node's width is predicted within ${TOLERANCE}px`,
    off.width.by <= TOLERANCE,
    `worst is ${off.width.by}px — ${off.width.detail}`,
  );
  check(
    `${family}: every node's height is predicted within ${TOLERANCE}px`,
    off.height.by <= TOLERANCE,
    `worst is ${off.height.by}px — ${off.height.detail}`,
  );
}

await browser.close();
console.log(
  failed
    ? "\nmeasurement FAILED — measureNode and the stylesheet disagree"
    : "\nmeasureNode predicts what the browser draws",
);
process.exit(failed ? 1 : 0);
