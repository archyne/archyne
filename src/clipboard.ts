/**
 * The canvas and the system clipboard.
 *
 * A copy on the canvas used to stay inside the app, so nothing copied there
 * could be pasted into a slide or an editor, and nothing copied elsewhere
 * could be pasted onto the canvas. Now a copy writes the selection three
 * ways at once and each application takes the one it understands:
 *
 * - `text/plain`, its Mermaid: what a text editor pastes.
 * - `image/png`, its picture: what an image editor pastes.
 * - `text/html`, the same picture as an `<img>`: what Office pastes. With
 *   plain text on the clipboard, PowerPoint prefers the text over a bare
 *   PNG and pasted the Mermaid source onto the slide; given HTML it takes
 *   the picture.
 *
 * A paste onto the canvas brings in a picture from anywhere as an image
 * node, and the app's own copy back as the nodes it was.
 */
import { useGraphStore } from "./store";
import { canCopyImage, dataUrlToBlob, picturePng, readDataUrl } from "./export";
import { toast, toastError } from "./toast";

/**
 * The Mermaid of the last copy made here. A paste that finds it on the
 * clipboard is the app's own copy coming back, and pastes the nodes rather
 * than the picture that was written beside them.
 */
let lastCopied: string | null = null;
/**
 * Whether that copy was the whole diagram, nothing being selected. Inside the
 * app there is nothing to paste from it: the nodes are all already here.
 */
let lastWhole = false;

/**
 * Whether text read off the clipboard is the copy made here. Windows hands
 * text back with its own line endings, so a straight comparison found the
 * app's own copy foreign and pasted it as a picture of itself.
 */
function isOurs(text: string): boolean {
  return text !== "" && text.replace(/\r\n?/g, "\n") === lastCopied;
}

/**
 * What a copy leaves: both forms, for each application to take its own —
 * or, from the menu, just one, for when the one an application prefers is
 * not the one wanted.
 */
export type CopyAs = "both" | "image" | "text";

/** Copy the selection — or the whole diagram — for other applications. */
export function copyToSystem(as: CopyAs = "both"): Promise<void> {
  const s = useGraphStore.getState();
  const part = s.copiedPart();
  if (part.nodes.length === 0 || !navigator.clipboard) return Promise.resolve();
  // A picture alone, pasted back here, is meant as a picture.
  lastCopied = as === "image" ? null : part.code;
  lastWhole = !s.nodes.some((n) => n.selected);
  if (as === "text") return navigator.clipboard.writeText(part.code);
  if (!canCopyImage()) {
    if (as === "image") return Promise.reject(new Error("this browser cannot copy pictures"));
    return navigator.clipboard.writeText(part.code);
  }
  // The picture takes a moment to draw, and the write must begin while the
  // key press still counts as the user's: the clipboard takes promises.
  const picture = picturePng(
    part.nodes,
    part.edges,
    s.kind,
    // The light palette whatever the app's theme: the picture has no ground
    // of its own and lands on a white slide or page, where the dark theme's
    // pale words — a caption, a group's name, anything outside a box — could
    // not be read.
    "light",
    s.classDefs,
  );
  return navigator.clipboard.write([
    new ClipboardItem({
      ...(as === "both" ? { "text/plain": new Blob([part.code], { type: "text/plain" }) } : {}),
      "image/png": picture.then((p) => dataUrlToBlob(p.dataUrl)),
      "text/html": picture.then(
        (p) =>
          new Blob(
            [`<img src="${p.dataUrl}" width="${p.width}" height="${p.height}" alt="">`],
            {
              type: "text/html",
            },
          ),
      ),
    }),
  ]);
}

/** Copy, and say so if the system clipboard would not take it. */
export function copyNow(as: CopyAs = "both"): void {
  useGraphStore.getState().copySelection();
  copyToSystem(as).catch((err: unknown) => toastError("toast.copyFailed", err));
}

/** The longest side a pasted picture keeps, in pixels. */
const MAX_PIXELS = 1024;
/** The longest side it is drawn at on the canvas, to begin with. */
const SHOWN = 240;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("not a picture this browser can read"));
    img.src = src;
  });
}

/**
 * A pasted picture, ready to go in the document.
 *
 * It travels inside the Mermaid as a data URL, so a photograph straight off
 * the web is scaled down first: at full size it would be megabytes of text
 * in the editor. An SVG is kept as it is, being small and sharp at any size.
 */
export async function pictureFrom(
  blob: Blob,
): Promise<{ src: string; width: number; height: number }> {
  let src = await readDataUrl(blob);
  const img = await loadImage(src);
  const width = img.naturalWidth || SHOWN;
  const height = img.naturalHeight || SHOWN;
  const longest = Math.max(width, height);
  if (longest > MAX_PIXELS && blob.type !== "image/svg+xml") {
    const f = MAX_PIXELS / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * f);
    canvas.height = Math.round(height * f);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    src = canvas.toDataURL(blob.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
  }
  const f = Math.min(1, SHOWN / longest);
  return { src, width: Math.round(width * f), height: Math.round(height * f) };
}

async function placePicture(blob: Blob, at: { x: number; y: number }): Promise<void> {
  try {
    if (!useGraphStore.getState().pasteImage(await pictureFrom(blob), at)) {
      toast("toast.pictureNeedsFlowchart", "error");
    }
  } catch (err) {
    toastError("toast.pasteFailed", err);
  }
}

/**
 * A paste on the canvas, from the event's own clipboard data: the app's own
 * copy comes back as nodes, a picture from elsewhere as an image node, and
 * anything else leaves what was copied here last to paste, as before.
 */
export function pasteFrom(data: DataTransfer | null, at: { x: number; y: number }): void {
  const s = useGraphStore.getState();
  const text = data?.getData("text/plain") ?? "";
  const image = data ? [...data.files].find((f) => f.type.startsWith("image/")) : undefined;
  const ours = isOurs(text);
  if (image && !ours) {
    void placePicture(image, at);
    return;
  }
  if (!(ours && lastWhole)) s.pasteClipboard();
}

/**
 * The same, from the menu, where there is no paste event to read: the
 * clipboard is asked instead, which the browser may first ask the user.
 */
export async function pasteFromMenu(at: { x: number; y: number }): Promise<void> {
  try {
    const [item] = await navigator.clipboard.read();
    const ours =
      item?.types.includes("text/plain") &&
      isOurs(await (await item.getType("text/plain")).text());
    const type = item?.types.find((t) => t.startsWith("image/"));
    if (item && type && !ours) {
      await placePicture(await item.getType(type), at);
      return;
    }
    if (ours && lastWhole) return;
  } catch {
    // No reading the clipboard here, or nothing on it: what was copied in
    // the app is still there to paste.
  }
  useGraphStore.getState().pasteClipboard();
}
