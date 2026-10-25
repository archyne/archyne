/**
 * Opening a file that is not Mermaid.
 *
 * One place decides what an opened file *is* and, when it is something else,
 * turns it into Mermaid before anything downstream sees it. Everything past
 * this point — the store, the workspace, save, undo — deals only in Mermaid
 * documents and needs no notion of a foreign format.
 *
 * The converters themselves are fetched on demand. Most sessions never open
 * anything but `.mmd`, and neither the draw.io reader nor the decompressor it
 * needs belongs in the bundle those sessions download.
 */
import type { PickedFile } from "./files";
import type { DiagramKind } from "./model/types";

/**
 * A draw.io file, near enough. Both spellings occur: `.drawio` files wrap the
 * pages in `<mxfile>`, while an `.xml` exported from an older version can be
 * a bare `<mxGraphModel>`.
 *
 * Anchored to the start of the document rather than searched for anywhere in
 * it. A Mermaid diagram with `<mxfile>` inside a node's label is a silly
 * thing to have, but it is a valid one, and mistaking it for draw.io would
 * replace the diagram with a conversion error. Nothing but the head is
 * examined either — a compressed page is one very long base64 line.
 */
export function isDrawio(content: string): boolean {
  // A real file may open with a byte-order mark, an XML declaration, or a
  // comment or two. JavaScript's `\s` covers the byte-order mark.
  const head = content.slice(0, 4096).replace(/^\s*(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|\s)*/, "");
  return /^<\s*(mxfile|mxGraphModel)[\s>]/.test(head);
}

/**
 * A Graphviz DOT file.
 *
 * The brace matters. `digraph` is unambiguous, but `graph` is *also* how a
 * Mermaid flowchart may open — `graph TD` is one — and the difference is that
 * DOT opens a body on the same statement while Mermaid puts a direction there
 * and then a newline. Without the brace, opening an ordinary Mermaid file
 * would try to convert it.
 */
export function isDot(content: string): boolean {
  const head = content
    .slice(0, 4096)
    .replace(/^(?:\s|\/\/[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "");
  return /^(strict\s+)?(di)?graph\b[^\n{]*\{/.test(head);
}

/**
 * SQL DDL.
 *
 * Looks for a `CREATE TABLE` anywhere rather than at the start: a dump opens
 * with pages of `SET` statements and comments, and a hand-written schema
 * often opens with `DROP TABLE IF EXISTS`. Requiring the whole file to be
 * DDL would exclude every real one.
 */
export function isSql(content: string): boolean {
  return /\bCREATE\s+(?:\w+\s+)*TABLE\b/i.test(content.slice(0, 65536));
}

/**
 * An Excalidraw scene. The `type` field is the format's own marker and sits
 * near the top of every file it writes.
 */
export function isExcalidraw(content: string): boolean {
  const head = content.slice(0, 4096);
  return /^\s*\{/.test(head) && /"type"\s*:\s*"excalidraw/.test(head);
}

/**
 * PlantUML, of any family. The converter handles sequence diagrams only and
 * refuses the rest by name — which is a better answer than not recognising
 * the file at all and reporting that it is not valid Mermaid.
 */
export function isPlantuml(content: string): boolean {
  return /^\s*@start\w+/m.test(content.slice(0, 4096));
}

/**
 * A Lucid Standard Import document.
 *
 * Usually a `.lucid` file — the zip holding `document.json` — but the
 * document on its own is also a file somebody could have exported. There is
 * no marker field to sniff, so the shape has to: a JSON object with a `pages`
 * array whose first page carries `shapes`, `lines` or `groups` is something
 * no other JSON Archyne opens has.
 *
 * Checked before SQL: a Lucid diagram can literally contain `CREATE TABLE`
 * in a label, and then the two sniffers would disagree about what it is.
 */
export function isLucid(content: string): boolean {
  // Cheap rejection before parsing the whole document.
  if (!/^\s*\{/.test(content)) return false;
  try {
    const head = JSON.parse(content);
    if (!Array.isArray(head?.pages) || head.pages.length === 0) return false;
    const page = head.pages[0];
    if (!page || typeof page !== "object") return false;
    return ["shapes", "lines", "groups"].some((k) => Array.isArray(page[k]));
  } catch {
    return false;
  }
}

/** What a conversion did, for the message shown afterwards. */
export interface ImportSummary {
  format: "drawio" | "dot" | "sql" | "excalidraw" | "plantuml" | "vsdx" | "lucid";
  nodes: number;
  edges: number;
  /** Every page in the source. `page` says which was converted. */
  pages: string[];
  /** Cells that had no Mermaid equivalent and were left out. */
  dropped: number;
  /**
   * The family the source appeared to be, when it is not the one produced.
   * A draw.io sequence diagram is lifelines on the ordinary canvas, so it
   * converts as a flowchart — and the user is told that rather than left to
   * work out why their diagram looks wrong.
   */
  looksLike?: string;
  /**
   * The Mermaid families this source could be read as, with the one that was
   * chosen first. More than one means the choice is a real one and the
   * preview offers it — a PlantUML file could be three things, and a DOT file
   * two, and detection is a guess that the reader can overrule.
   */
  choices: DiagramKind[];
  /**
   * Which page of a multi-page file came across, as an index. Set by the
   * formats whose pages can be chosen between — draw.io, Visio and Lucid —
   * and left unset by the rest, which convert the first.
   */
  page?: number;
}

export interface OpenedFile {
  file: PickedFile;
  /** Null when the file was already Mermaid and was passed through. */
  imported: ImportSummary | null;
  /** The file as chosen, kept so the preview can convert it again. */
  source: PickedFile;
}

/**
 * Convert an opened file if it is not Mermaid; pass it through if it is.
 *
 * An imported diagram is **deliberately unbound from the file it came from**:
 * no path, no handle. Save would otherwise write Mermaid over somebody's
 * `.drawio`, destroying the original in a format its own editor cannot read
 * back. Save becomes Save-as, into a new `.mmd`, and the source file is left
 * exactly as it was found.
 */
export async function openAsMermaid(
  file: PickedFile,
  as?: DiagramKind,
  page?: number,
): Promise<OpenedFile> {
  const converted = file.bytes
    ? await convertBinary(file.bytes, page)
    : await convert(file.content, as, page);
  if (!converted) return { file, imported: null, source: file };

  const FOREIGN =
    /\.(drawio\.xml|drawio|xml|vsdx|lucid|json|gv|dot|sql|ddl|excalidraw|puml|plantuml|iuml|wsd)$/i;
  return {
    file: {
      name: `${file.name.replace(FOREIGN, "")}.mmd`,
      content: converted.code,
      path: null,
      handle: null,
    },
    imported: converted.summary,
    source: file,
  };
}

/**
 * A file that is not text at all. Two zips arrive here — a Visio package and
 * a Lucid `.lucid` — both already recognised by the zip signature, so which
 * reader gets the file is told by what is inside it.
 */
async function convertBinary(
  bytes: Uint8Array,
  page?: number,
): Promise<{ code: string; summary: ImportSummary } | null> {
  const { isLucidZip, lucidToMermaid } = await import("./model/fromLucid");
  if (isLucidZip(bytes)) {
    const result = lucidToMermaid(bytes, page);
    return {
      code: result.code,
      summary: {
        format: "lucid",
        choices: ["flowchart"],
        nodes: result.nodes,
        edges: result.edges,
        pages: result.pages,
        page: result.page,
        dropped: result.dropped,
      },
    };
  }

  const { vsdxToMermaid } = await import("./model/fromVsdx");
  const result = vsdxToMermaid(bytes, page);
  return {
    code: result.code,
    summary: {
      format: "vsdx",
      choices: ["flowchart"],
      nodes: result.nodes,
      edges: result.edges,
      pages: result.pages,
      page: result.page,
      dropped: result.dropped,
    },
  };
}

/** The one place that knows which formats there are. Null means Mermaid. */
async function convert(
  content: string,
  as?: DiagramKind,
  page?: number,
): Promise<{ code: string; summary: ImportSummary } | null> {
  if (isDrawio(content)) {
    const { drawioToMermaid } = await import("./model/fromDrawio");
    const result = drawioToMermaid(
      content,
      as === "architecture" || as === "flowchart" ? as : undefined,
      page,
    );
    return {
      code: result.code,
      summary: {
        format: "drawio",
        choices: ["flowchart", "architecture"],
        nodes: result.nodes,
        edges: result.edges,
        pages: result.pages,
        page: result.page,
        dropped: result.dropped,
        ...(result.looksLike ? { looksLike: result.looksLike } : {}),
      },
    };
  }

  if (isDot(content)) {
    const { dotToMermaid } = await import("./model/fromDot");
    const result = dotToMermaid(content, as === "class" || as === "flowchart" ? as : undefined);
    return {
      code: result.code,
      summary: {
        format: "dot",
        choices: ["flowchart", "class"],
        nodes: result.nodes,
        edges: result.edges,
        pages: [],
        dropped: result.dropped,
      },
    };
  }

  if (isExcalidraw(content)) {
    const { excalidrawToMermaid } = await import("./model/fromExcalidraw");
    const result = excalidrawToMermaid(content);
    return {
      code: result.code,
      summary: {
        format: "excalidraw",
        choices: ["flowchart"],
        nodes: result.nodes,
        edges: result.edges,
        pages: [],
        dropped: result.dropped,
      },
    };
  }

  if (isPlantuml(content)) {
    // PlantUML is several languages behind one pair of markers, so which
    // Mermaid family this becomes is read off the file rather than fixed.
    const { plantumlFamily, plantumlToMermaid } = await import("./model/fromPlantuml");
    const family =
      as === "class" || as === "state" || as === "sequence" ? as : plantumlFamily(content);
    const result =
      family === "sequence"
        ? plantumlToMermaid(content)
        : await (async () => {
            const kinds = await import("./model/plantumlFamilies");
            return family === "class"
              ? kinds.plantumlClassToMermaid(content)
              : kinds.plantumlStateToMermaid(content);
          })();
    return {
      code: result.code,
      summary: {
        format: "plantuml",
        choices: ["sequence", "class", "state"],
        nodes: result.nodes,
        edges: result.edges,
        pages: [],
        dropped: result.dropped,
      },
    };
  }

  if (isLucid(content)) {
    const { lucidJsonToMermaid } = await import("./model/fromLucid");
    const result = lucidJsonToMermaid(content, page);
    return {
      code: result.code,
      summary: {
        format: "lucid",
        choices: ["flowchart"],
        nodes: result.nodes,
        edges: result.edges,
        pages: result.pages,
        page: result.page,
        dropped: result.dropped,
      },
    };
  }

  if (isSql(content)) {
    const { sqlToMermaid } = await import("./model/fromSql");
    const result = sqlToMermaid(content);
    return {
      code: result.code,
      summary: {
        format: "sql",
        choices: ["er"],
        nodes: result.nodes,
        edges: result.edges,
        pages: [],
        dropped: result.dropped,
      },
    };
  }

  return null;
}
