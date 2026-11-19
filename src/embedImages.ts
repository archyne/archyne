/**
 * Pictures in an imported drawing, brought into the diagram as data.
 *
 * A draw.io shape can be any image on the web, and real drawings are full of
 * them: iconfinder, Wikimedia, a vendor's site. The page loads images from a
 * short list of hosts only (`img-src` in `index.html`), so each of those came
 * across as an empty box. Widening that list would let every diagram anyone
 * opens make the app call wherever it likes; instead the desktop shell, which
 * is not bound by CORS, fetches each picture once, at import, and it goes into
 * the file as a data URL. The diagram then draws offline, in every viewer, and
 * opening it reaches nobody.
 *
 * In a browser there is no shell to ask, and the pictures stay links, as they
 * were. Pictures on the hosts the page already loads from stay links too: the
 * link is what lets other tools draw them, which is the point of the shape.
 */
import { desktopBridge } from "./files";
import { ICON_HOSTS } from "./model/iconUrl";

/** A picture written into a node: `img: "https://…"`. */
const PICTURE = /\bimg: "(https?:\/\/[^"\s]+)"/g;

/** What has been fetched this session, so the import preview's re-runs do not fetch again. */
const fetched = new Map<string, string | null>();

/** Whether the page can draw this link as it is. */
function loadsAlready(link: string): boolean {
  try {
    return (ICON_HOSTS as readonly string[]).includes(new URL(link).hostname);
  } catch {
    return false;
  }
}

/** How the pictures fared, for the import summary. */
export interface Embedded {
  /** Pictures now carried in the diagram. */
  embedded: number;
  /** Links that gave no picture, and stay links. */
  failed: number;
}

/**
 * The diagram with its outside pictures carried as data, or as it was when
 * there is nothing to fetch or nothing to fetch with.
 */
export async function embedImages(code: string): Promise<{ code: string } & Embedded> {
  const links = [...new Set([...code.matchAll(PICTURE)].map((m) => m[1]))].filter(
    (l) => !loadsAlready(l),
  );
  const fetchImages = desktopBridge()?.fetchImages;
  if (links.length === 0 || !fetchImages) return { code, embedded: 0, failed: 0 };

  const missing = links.filter((l) => !fetched.has(l));
  if (missing.length) {
    try {
      const { images } = await fetchImages(missing);
      for (const link of missing) {
        const data = images[link];
        fetched.set(
          link,
          typeof data === "string" && data.startsWith("data:image/") ? data : null,
        );
      }
    } catch {
      // The shell refused or failed outright: nothing changes, and the next
      // import asks again rather than remembering a failure that may pass.
      return { code, embedded: 0, failed: links.length };
    }
  }

  let embedded = 0;
  const out = code.replace(PICTURE, (whole, link: string) => {
    const data = fetched.get(link);
    if (!data) return whole;
    embedded++;
    return `img: "${data}"`;
  });
  const failed = links.filter((l) => !fetched.get(l)).length;
  return { code: out, embedded, failed };
}

/** Forget what was fetched; for tests. */
export function forgetFetchedImages(): void {
  fetched.clear();
}
