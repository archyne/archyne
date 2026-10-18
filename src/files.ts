import { create } from "zustand";
import { useGraphStore } from "./store";
import type { HostAi } from "./ai/hostBridge";

/**
 * Opening and saving `.mmd` files.
 *
 * Three backends, picked in order of fidelity:
 *
 * 1. **Desktop** — the Electron preload bridge, which knows the real path of
 *    a file opened by double-click and can write straight back to it.
 * 2. **File System Access API** — Chromium browsers, where Save writes back
 *    to the file the user opened rather than dropping a new copy in
 *    Downloads.
 * 3. **Download + `<input type=file>`** — everywhere else. Open reads a copy
 *    and Save produces a new download; there is no round-trip.
 *
 * Before this, every surface used backend 3: `Save .mmd` always wrote a fresh
 * `diagram.mmd` to Downloads, so open-edit-save never returned to the
 * original file.
 */

/**
 * A file from the shell. `base64` is present instead of `content` when the
 * file is binary — a `.vsdx` is a zip, and UTF-8 would destroy it.
 */
export interface DesktopFile {
  path: string;
  content: string;
  base64?: string;
}

/** Shape of the bridge exposed by `desktop/preload.cjs`. */
interface DesktopBridge {
  openedFile(): Promise<DesktopFile | null>;
  onOpenFile(cb: (file: DesktopFile) => void): void;
  showOpen(mode?: PickMode): Promise<DesktopFile | null>;
  showSave(defaultPath: string, content: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Modification time of a file, for noticing edits made outside the app.
   * Optional: a desktop build older than this feature will not have it, and
   * an app that simply does not watch is better than one that throws.
   */
  statFile?(path: string): Promise<{ mtimeMs: number } | null>;
  readFile?(path: string): Promise<string | null>;
  /**
   * Hand the resolved theme to the shell, which passes it to Chromium so the
   * widgets it draws itself match the app. Optional for the same reason as
   * the two above: an older desktop build will not have it.
   */
  setTheme?(theme: "dark" | "light"): void;
  /**
   * Download icons from links — the one call that reaches the network, and
   * the only reason it lives in the shell is that the shell is not bound by
   * CORS and can therefore take a vendor's `.zip`. Optional: without it the
   * renderer falls back to fetching single SVGs itself.
   */
  fetchIcons?(urls: string[]): Promise<{
    icons: Array<{ name: string; svg: string }>;
    failed: string[];
  }>;
  /** Generate through the shell, which keeps the secrets (desktop/ai.cjs). */
  ai?: HostAi;
}

function desktop(): DesktopBridge | null {
  return (globalThis as { archyne?: DesktopBridge }).archyne ?? null;
}

/** The desktop bridge, for the modules that need it beyond open and save. */
export function desktopBridge(): DesktopBridge | null {
  return desktop();
}

function supportsFsAccess(): boolean {
  return typeof globalThis.showSaveFilePicker === "function";
}

const MMD_TYPES = [
  { description: "Mermaid diagram", accept: { "text/plain": [".mmd", ".mermaid", ".txt"] } },
];

/**
 * What **Import** accepts. Open deliberately does not: opening a file means
 * editing it and saving it back, and none of these is ever written back —
 * Archyne writes Mermaid. Keeping them apart is what stops "Open" from
 * quietly meaning two different things.
 */
const IMPORT_TYPES = [
  {
    description: "Diagram",
    accept: {
      "text/plain": [
        ".mmd",
        ".mermaid",
        ".txt",
        ".dot",
        ".gv",
        ".sql",
        ".ddl",
        ".excalidraw",
        ".puml",
        ".plantuml",
        ".iuml",
        ".wsd",
      ],
      "application/xml": [".drawio", ".xml"],
      "application/vnd.ms-visio.drawing": [".vsdx"],
      // A `.lucid` has no registered MIME, and it is a zip on disk — listed
      // under the zip MIME is the closest honest home.
      "application/zip": [".lucid"],
    },
  },
];

/** Open edits a Mermaid file; Import converts something else into one. */
export type PickMode = "open" | "import";

/** A file the user chose, before anything has been done with it. */
export interface PickedFile {
  name: string;
  content: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
  /**
   * The raw bytes, for a format that is not text. A Visio drawing is a zip,
   * and decoding one as UTF-8 destroys it — so a binary file arrives with
   * `content` empty and the bytes here instead.
   */
  bytes?: Uint8Array;
}

/** The zip signature, which is how every binary format Archyne reads opens. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Read a chosen file as text, or as bytes when it is not text. */
export async function readPicked(file: File): Promise<{ content: string; bytes?: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isZip(bytes)) return { content: "", bytes };
  return { content: new TextDecoder().decode(bytes) };
}

/** Bytes back out of the base64 the desktop shell sends for a binary file. */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Show the picker and read the file. Nothing else.
 *
 * `open()` below applies the result to the current document, which is what
 * the app did when there was only one. With a workspace, *where* an opened
 * file lands is a decision that belongs to `documents.ts` — so it takes the
 * picking from here and does the placing itself. Keeping the two apart is
 * also what stops the import cycle: this module knows nothing of documents.
 */
export async function pickFile(mode: PickMode = "open"): Promise<PickedFile | null> {
  const bridge = desktop();
  if (bridge) {
    const file = await bridge.showOpen(mode);
    if (!file) return null;
    return {
      name: basename(file.path),
      content: file.content,
      path: file.path,
      handle: null,
      ...(file.base64 ? { bytes: decodeBase64(file.base64) } : {}),
    };
  }

  if (supportsFsAccess()) {
    let handle: FileSystemFileHandle;
    try {
      [handle] = await globalThis.showOpenFilePicker({
        types: mode === "import" ? IMPORT_TYPES : MMD_TYPES,
      });
    } catch {
      return null; // user cancelled
    }
    const read = await readPicked(await handle.getFile());
    return { name: handle.name, path: null, handle, ...read };
  }

  // No picker API: the caller falls back to a hidden <input type=file>.
  throw new Error("no-picker");
}

interface FileState {
  /** Display name of the open file, or null for an unsaved scratch diagram. */
  name: string | null;
  /** Desktop absolute path, when the desktop bridge is in play. */
  path: string | null;
  /** Browser handle, when the File System Access API is in play. */
  handle: FileSystemFileHandle | null;
  /** Code as it was last written to (or read from) disk. */
  savedCode: string | null;

  open: () => Promise<void>;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  /** Adopt a file the desktop shell opened for us. */
  adopt: (file: { path: string; content: string }) => Promise<void>;
}

/** True when the diagram differs from what is on disk. */
export function isDirty(): boolean {
  const { savedCode } = useFileStore.getState();
  if (savedCode === null) return false; // nothing opened yet — nothing to lose
  return savedCode !== useGraphStore.getState().code;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Last-resort download, for browsers without the File System Access API. */
function download(name: string, code: string) {
  const blob = new Blob([code], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function writeHandle(handle: FileSystemFileHandle, code: string) {
  const writable = await handle.createWritable();
  await writable.write(code);
  await writable.close();
}

export const useFileStore = create<FileState>((set, get) => ({
  name: null,
  path: null,
  handle: null,
  savedCode: null,

  adopt: async (file) => {
    await useGraphStore.getState().applyCode(file.content, { record: true });
    set({ name: basename(file.path), path: file.path, handle: null, savedCode: file.content });
  },

  open: async () => {
    const bridge = desktop();
    if (bridge) {
      const file = await bridge.showOpen();
      if (file) await get().adopt(file);
      return;
    }

    if (supportsFsAccess()) {
      let handle: FileSystemFileHandle;
      try {
        [handle] = await globalThis.showOpenFilePicker({ types: MMD_TYPES });
      } catch {
        return; // user cancelled
      }
      const content = await (await handle.getFile()).text();
      await useGraphStore.getState().applyCode(content, { record: true });
      set({ name: handle.name, path: null, handle, savedCode: content });
      return;
    }

    // No picker API: the caller falls back to a hidden <input type=file>.
    throw new Error("no-picker");
  },

  save: async () => {
    const { path, handle } = get();
    const code = useGraphStore.getState().code;
    const bridge = desktop();

    if (bridge && path) {
      await bridge.writeFile(path, code);
      set({ savedCode: code });
      return;
    }
    if (handle) {
      await writeHandle(handle, code);
      set({ savedCode: code });
      return;
    }
    await get().saveAs();
  },

  saveAs: async () => {
    const code = useGraphStore.getState().code;
    const suggested = get().name ?? "diagram.mmd";
    const bridge = desktop();

    if (bridge) {
      const path = await bridge.showSave(suggested, code);
      if (path) set({ name: basename(path), path, handle: null, savedCode: code });
      return;
    }

    if (supportsFsAccess()) {
      let handle: FileSystemFileHandle;
      try {
        handle = await globalThis.showSaveFilePicker({
          suggestedName: suggested,
          types: MMD_TYPES,
        });
      } catch {
        return; // user cancelled
      }
      await writeHandle(handle, code);
      set({ name: handle.name, path: null, handle, savedCode: code });
      return;
    }

    download(suggested, code);
    // A download is fire-and-forget: the browser never tells us where it
    // landed, so this is the one path that cannot track "saved" state.
    set({ savedCode: code });
  },
}));

/**
 * Pick up a file the desktop shell was launched with, or opened later.
 *
 * The handler is passed in rather than hard-coded: with a workspace, a file
 * arriving from the shell should land beside your work rather than on top of
 * it, and that decision lives in `documents.ts`.
 */
export function initDesktopFiles(
  onFile: (file: { path: string; content: string }) => void,
): void {
  const bridge = desktop();
  if (!bridge) return;
  void bridge.openedFile().then((file) => {
    if (file) onFile(file);
  });
  bridge.onOpenFile(onFile);
}
