/**
 * draw.io's stencils: the drawings behind `shape=mxgraph.cisco.routers.router`
 * and the thousands of names like it.
 *
 * A draw.io file names its shapes and does not draw them. The drawing is in
 * draw.io's stencil library, a set of small vector programs — move here, line
 * to there, fill and stroke — one per shape, which draw.io runs with the
 * cell's own colours. To draw a shape as draw.io does, the importer needs
 * that program; `stencilSvg.ts` runs it.
 *
 * The library is not in this repository. Its folder carries a restriction of
 * its own beyond the Apache licence (no use in Atlassian products without
 * permission), and Archyne is MIT, so it is not redistributed here. It is
 * fetched from draw.io's own repository when a drawing that uses it is
 * imported, at a pinned commit, and read as data: the file is JavaScript, and
 * none of it is run — the string literals holding each package are picked out
 * of it and decoded by the port of draw.io's decoder below.
 *
 * Offline, or when the fetch fails, there is no library and shapes fall back
 * to their frame (see `fromDrawio.ts`).
 */
import { inflateSync } from "fflate";

/** One node of a stencil program: `<path>`, `<move x y/>`, `<fillstroke/>`. */
export interface StencilNode {
  name: string;
  attrs: Record<string, string>;
  children: StencilNode[];
}

/** A stencil by its full name, lower case: `mxgraph.cisco.routers.router`. */
export type StencilLookup = (name: string) => StencilNode | undefined;

/**
 * Where the library comes from: draw.io's packed stencils, at the commit they
 * were last changed. Pinned, because the packing is draw.io's own and the
 * decoder below is written against this version of it.
 */
export const STENCILS_URL =
  "https://raw.githubusercontent.com/jgraph/drawio/84487b4891cbc0f32d7e30f34cf878c87cb1f414/src/main/webapp/js/stencils.min.js";

/** Each package's packed text, by file name: `cisco/routers.xml` → `7H0J…`. */
export function packagesIn(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\bf\['([\w./-]+\.xml)'\]\s*=\s*'([A-Za-z0-9+/=]*)'/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * One package, unpacked into its stencils by full name.
 *
 * A port of `decode` in draw.io's `stencils.min.js`: base64, raw DEFLATE, then
 * five streams — operations, x deltas, y deltas, other numbers, strings —
 * that rebuild the package's XML element by element. Numbers are zigzag
 * varints in thousandths; coordinates are deltas within a shape.
 */
export function decodePackage(packed: string): Map<string, StencilNode> {
  const raw = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  const d = inflateSync(raw);
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const streams: Uint8Array[] = [];
  for (let i = 0, o = 20; i < 5; i++) {
    const n = view.getUint32(4 * i);
    streams.push(d.subarray(o, o + n));
    o += n;
  }
  const ops = streams[0];
  const strs = new TextDecoder().decode(streams[4]).split("\0");
  const at = [0, 0, 0, 0];
  let si = 0;
  const names: string[] = [];
  const attrNames: string[] = [];
  const draws = new Set([
    "move",
    "line",
    "quad",
    "curve",
    "arc",
    "rect",
    "roundrect",
    "ellipse",
    "text",
    "image",
    "include-shape",
  ]);
  const xs = new Set(["x", "x1", "x2", "x3"]);
  const ys = new Set(["y", "y1", "y2", "y3"]);

  const read = (k: number) => {
    const bytes = streams[k];
    let n = 0;
    let m = 1;
    let c: number;
    do {
      c = bytes[at[k]++];
      n += (c & 127) * m;
      m *= 128;
    } while (c & 128);
    return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
  };
  const format = (n: number) => String(n / 1000);

  const root: StencilNode = { name: "", attrs: {}, children: [] };
  const stack: StencilNode[] = [root];
  let px = 0;
  let py = 0;
  let pn = new Map<string, number>();
  while (at[0] < ops.length) {
    const op = ops[at[0]++];
    if (op === 255) {
      stack.pop();
      continue;
    }
    if (op >> 1 === names.length) names.push(strs[si++]);
    const name = names[op >> 1];
    const node: StencilNode = { name, attrs: {}, children: [] };
    stack[stack.length - 1].children.push(node);
    const count = ops[at[0]++];
    const coords = draws.has(name);
    if (name === "shape") {
      px = 0;
      py = 0;
      pn = new Map();
    }
    for (let i = 0; i < count; i++) {
      const id = ops[at[0]++];
      if (id === attrNames.length) attrNames.push(strs[si++]);
      const attr = attrNames[id];
      if (ops[at[0]++] === 0) {
        node.attrs[attr] = strs[si++];
      } else if (coords && xs.has(attr)) {
        px += read(1);
        node.attrs[attr] = format(px);
      } else if (coords && ys.has(attr)) {
        py += read(2);
        node.attrs[attr] = format(py);
      } else {
        const key = `${name} ${attr}`;
        const next = (pn.get(key) ?? 0) + read(3);
        pn.set(key, next);
        node.attrs[attr] = format(next);
      }
    }
    // The low bit says the element is empty; otherwise its children follow.
    if (!(op & 1)) stack.push(node);
  }

  return stencilsOf(root);
}

/**
 * Every `<shape>` under a `<shapes name="mxgraph.cisco.routers">`, by the name
 * draw.io looks it up by: the package's name, a dot, and the shape's name
 * with its spaces as underscores, all lower case.
 */
export function stencilsOf(root: StencilNode): Map<string, StencilNode> {
  const out = new Map<string, StencilNode>();
  const walk = (node: StencilNode) => {
    if (node.name === "shapes") {
      const pkg = (node.attrs.name ?? "").toLowerCase();
      for (const shape of node.children) {
        if (shape.name !== "shape" || !shape.attrs.name) continue;
        const name = shape.attrs.name.replace(/ /g, "_").toLowerCase();
        out.set(pkg ? `${pkg}.${name}` : name, shape);
      }
      return;
    }
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** A stencil package written as XML, read the same way; for tests and for packages held locally. */
export function stencilsFromXml(xml: string): Map<string, StencilNode> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const convert = (el: Element): StencilNode => ({
    name: el.tagName,
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    children: [...el.children].map(convert),
  });
  return stencilsOf({ name: "", attrs: {}, children: [convert(doc.documentElement)] });
}

/** Every stencil name a drawing's styles mention: `mxgraph.` and what follows. */
export function stencilNames(styles: string[]): Set<string> {
  const out = new Set<string>();
  for (const style of styles) {
    for (const m of style.matchAll(/=\s*(mxgraph\.[\w.-]+)/gi)) out.add(m[1].toLowerCase());
  }
  return out;
}

let library: Promise<Map<string, string> | null> | null = null;
const unpacked = new Map<string, Map<string, StencilNode>>();

/** The packed library, fetched once per session; `null` when it cannot be had. */
function packed(fetcher: typeof fetch): Promise<Map<string, string> | null> {
  library ??= fetcher(STENCILS_URL)
    .then((res) => (res.ok ? res.text() : null))
    .then((text) => (text ? packagesIn(text) : null))
    .catch(() => null)
    .then((map) => {
      // A failure is not remembered: the next import tries again.
      if (!map || map.size === 0) library = null;
      return map && map.size ? map : null;
    });
  return library;
}

/**
 * The stencils `names` need, as a lookup — or one that finds nothing, when the
 * library cannot be fetched.
 *
 * Only the packages those names could live in are unpacked: a package's file
 * is named for it (`cisco/routers.xml` holds `mxgraph.cisco.routers`), so a
 * name's own parts say where to look first, and the rest are unpacked only
 * for a name not found that way.
 */
export async function loadStencils(
  names: Iterable<string>,
  fetcher: typeof fetch = fetch,
): Promise<StencilLookup> {
  const wanted = [...names].map((n) => n.toLowerCase());
  const found = new Map<string, StencilNode>();
  if (wanted.length === 0) return () => undefined;
  const files = await packed(fetcher);
  if (!files) return () => undefined;

  const open = (file: string) => {
    let shapes = unpacked.get(file);
    if (!shapes) {
      try {
        shapes = decodePackage(files.get(file)!);
      } catch {
        shapes = new Map();
      }
      unpacked.set(file, shapes);
    }
    return shapes;
  };
  const likely = (name: string) => {
    const parts = name.replace(/^mxgraph\./, "").split(".");
    return [...files.keys()].filter((file) => {
      const path = file
        .replace(/\.xml$/, "")
        .toLowerCase()
        .split("/");
      return path.every((p, i) => p === parts[i]);
    });
  };

  let everything = false;
  // A stencil may draw another inside it (`<include-shape name="…"/>`), so
  // those are wanted too, as they turn up.
  const included = (node: StencilNode): string[] =>
    node.name === "include-shape" && node.attrs.name
      ? [node.attrs.name.toLowerCase()]
      : node.children.flatMap(included);
  for (let i = 0; i < wanted.length; i++) {
    const name = wanted[i];
    for (const file of likely(name)) {
      const hit = open(file).get(name);
      if (hit) {
        found.set(name, hit);
        break;
      }
    }
    if (!found.has(name) && !everything) {
      for (const file of files.keys()) open(file);
      everything = true;
    }
    if (!found.has(name)) {
      for (const shapes of unpacked.values()) {
        const hit = shapes.get(name);
        if (hit) {
          found.set(name, hit);
          break;
        }
      }
    }
    const hit = found.get(name);
    if (hit) for (const more of included(hit)) if (!wanted.includes(more)) wanted.push(more);
  }
  return (name) => found.get(name.toLowerCase());
}
