/**
 * An icon from the palette, put in a flowchart.
 *
 * A flowchart has no icon node of its own — Mermaid's `icon:` shape draws
 * only where the reader has registered that icon pack, which GitHub and most
 * viewers have not — so the icon goes in as a picture, Mermaid's `img:` shape,
 * with its name under it: the shape an imported draw.io cloud diagram already
 * takes. The picture is the icon's SVG carried in the file, so it draws
 * offline and in every viewer, with nothing fetched.
 */
import { useGraphStore } from "./store";
import { useIconPrefs } from "./iconPrefs";
import { getIconHtml } from "./icons";
import { plainName } from "./model/iconRole";
import type { NodeSeed } from "./model/types";
import { toastError } from "./toast";

/** The longest side an icon is drawn at when it arrives. */
const ICON_PICTURE = 48;

/** A name to read under the icon: `azure:10061-icon-service-key-vaults` → "Key vaults". */
export function iconCaption(ref: string): string {
  const words = plainName(ref)
    .replace(/^\d+-icon-service-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** The icon's SVG as a picture to put in the file, at its own proportions. */
export async function iconPicture(
  ref: string,
): Promise<{ src: string; width: number; height: number }> {
  let svg = (await getIconHtml(ref)).trim();
  if (!/^<svg\b[^>]*\sxmlns=/.test(svg)) {
    svg = svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  const w = box ? Number(box[1]) : 1;
  const h = box ? Number(box[2]) : 1;
  const f = ICON_PICTURE / Math.max(w, h) || 1;
  // Base64 rather than percent-encoding: an icon's markup is full of quotes
  // and `#`, and this way the picture is one unbroken word in the Mermaid.
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return {
    src: `data:image/svg+xml;base64,${btoa(binary)}`,
    width: Math.round(w * f) || ICON_PICTURE,
    height: Math.round(h * f) || ICON_PICTURE,
  };
}

/**
 * Add what the palette hands over, where it was dropped: an icon becomes a
 * picture in a flowchart and a service everywhere else; anything else goes
 * in as it always has.
 */
export function addSeed(seed: NodeSeed, at: { x: number; y: number }): void {
  const s = useGraphStore.getState();
  const icon =
    seed.type === "service" ? seed.icon : seed.type === "group" ? seed.icon : undefined;
  if (s.kind !== "flowchart" || !icon) {
    s.addNode(seed, at);
    return;
  }
  void iconPicture(icon).then(
    (picture) => {
      useIconPrefs.getState().recordRecent(icon);
      useGraphStore.getState().pasteImage({ ...picture, label: iconCaption(icon) }, at);
    },
    (err: unknown) => toastError("toast.pasteFailed", err),
  );
}
