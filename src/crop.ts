/**
 * Cropping a node's picture.
 *
 * The crop is cut into the picture itself rather than kept beside it as a
 * window onto the whole: Mermaid's image shape has no notion of a crop, so a
 * window would be Archyne's alone, and the Live Editor, GitHub and every
 * export would show the picture uncut. The cut picture is what the file
 * holds, and undo is what brings the rest back.
 */
import { readDataUrl } from "./export";

/** A rectangle in the picture's own pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The least a crop may leave, in the picture's pixels, so a drag cannot lose it. */
export const MIN_CROP = 4;

/**
 * Keep a crop inside a picture `natural` pixels in size, and no smaller than
 * `MIN_CROP` a side. Whole pixels, since that is what will be cut.
 */
export function clampCrop(
  rect: CropRect,
  natural: { width: number; height: number },
): CropRect {
  const width = Math.round(Math.min(Math.max(rect.width, MIN_CROP), natural.width));
  const height = Math.round(Math.min(Math.max(rect.height, MIN_CROP), natural.height));
  const x = Math.round(Math.min(Math.max(rect.x, 0), natural.width - width));
  const y = Math.round(Math.min(Math.max(rect.y, 0), natural.height - height));
  return { x, y, width, height };
}

/**
 * The size the cut picture is drawn at: the part kept, at the scale the whole
 * was drawn at. Cropping a logo out of a screenshot leaves the logo the size it
 * was on the canvas, rather than blowing it up to fill the old frame.
 */
export function croppedSize(
  shown: { width: number; height: number },
  natural: { width: number; height: number },
  rect: CropRect,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round((shown.width * rect.width) / natural.width)),
    height: Math.max(1, Math.round((shown.height * rect.height) / natural.height)),
  };
}

/**
 * A picture, loaded so its pixels can be read.
 *
 * One held as data is read as it is. One linked from the web is fetched first:
 * drawn straight from another host it would taint the canvas, and a tainted
 * canvas cannot be read back into a picture.
 */
export async function loadForCrop(
  src: string,
): Promise<{ image: HTMLImageElement; type: string }> {
  let data = src;
  if (!src.startsWith("data:")) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await readDataUrl(await res.blob());
  }
  const type = /^data:([^;,]+)/.exec(data)?.[1] ?? "image/png";
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("not a picture this browser can read"));
    img.src = data;
  });
  return { image, type };
}

/**
 * Cut `rect` out of `image`, as a data URL.
 *
 * A JPEG stays a JPEG — a photo as PNG is several times the size, and it all
 * travels inside the Mermaid. Everything else becomes PNG, which keeps
 * transparency. An SVG has to become pixels to be cut, so it is cut at twice
 * its size, to stay sharp at the size it is drawn.
 */
export function cutPicture(image: HTMLImageElement, type: string, rect: CropRect): string {
  const scale = type === "image/svg+xml" ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas to cut the picture on");
  ctx.drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return type === "image/jpeg"
    ? canvas.toDataURL("image/jpeg", 0.92)
    : canvas.toDataURL("image/png");
}
