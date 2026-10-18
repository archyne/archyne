/**
 * Archyne desktop shell: a thin Electron window around the static build.
 *
 * Everything still runs locally in the renderer — no backend. The shell
 * reaches the network in two places, each only because the user asked:
 * `archyne:fetch-icons`, for a link they pasted (see the notes there), and
 * the Generate engines in ./ai.cjs, for a service they configured.
 */
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { unzipSync } = require("fflate");
const { registerAiIpc } = require("./ai.cjs");

/**
 * .mmd file passed on the command line (double-click / "open with").
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function fileArg(argv) {
  // `.xml` is deliberately not here: the installer associates `.mmd`, and
  // picking up any stray XML on the command line would be a surprise. A
  // draw.io file named `.xml` can still be opened from the dialog.
  const openable =
    /\.(mmd|mermaid|drawio|vsdx|dot|gv|sql|ddl|excalidraw|puml|plantuml|iuml|wsd)$/i;
  return argv.find((a) => openable.test(a) && fs.existsSync(a));
}

/**
 * File the app was launched with, handed to the renderer over IPC once it
 * asks. Passing it through the URL — as this used to — broke on large
 * diagrams and lost the path, so saving could never write back to it.
 * @type {string | undefined}
 */
let pendingFile;

const FILTERS = [
  { name: "Mermaid diagram", extensions: ["mmd", "mermaid"] },
  { name: "All files", extensions: ["*"] },
];

const IMPORTABLE = [
  "drawio",
  "xml",
  "vsdx",
  "lucid",
  "dot",
  "gv",
  "sql",
  "ddl",
  "excalidraw",
  "puml",
  "plantuml",
  "iuml",
  "wsd",
];

/**
 * What **Import** offers. Open shows `FILTERS` instead: opening a file means
 * editing it and saving it back, and none of these is ever written back — the
 * renderer converts it and unbinds it from its source, so Save always writes
 * Mermaid.
 */
const IMPORT_FILTERS = [
  { name: "Any importable drawing", extensions: IMPORTABLE },
  { name: "draw.io diagram", extensions: ["drawio", "xml"] },
  { name: "Visio drawing", extensions: ["vsdx"] },
  { name: "Lucidchart drawing", extensions: ["lucid"] },
  { name: "Graphviz DOT", extensions: ["dot", "gv"] },
  { name: "SQL schema", extensions: ["sql", "ddl"] },
  { name: "PlantUML sequence", extensions: ["puml", "plantuml", "iuml", "wsd"] },
  { name: "Excalidraw scene", extensions: ["excalidraw"] },
  { name: "All files", extensions: ["*"] },
];

/** @param {string} [openFile] */
function createWindow(openFile) {
  if (openFile) pendingFile = openFile;

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    // The layout now collapses the palette and side panel into drawers below
    // 900px, so the window no longer has to stay that wide to be usable.
    minWidth: 680,
    minHeight: 520,
    backgroundColor: "#12141a",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // External links open in the default browser, not in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return win;
}

/**
 * Read a file for the renderer; a failure surfaces as a rejected invoke.
 * @param {string} filePath
 */
async function readFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  // A Visio drawing is a zip, and decoding one as UTF-8 destroys it. Anything
  // that opens with the zip signature crosses to the renderer as base64
  // instead, and only the importers ever look at it.
  const zip =
    buffer.length > 3 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;
  if (zip) return { path: filePath, content: "", base64: buffer.toString("base64") };
  return { path: filePath, content: buffer.toString("utf8") };
}

/**
 * Downloading icons — the shell's one outward call, and the reason it exists
 * here rather than in the page.
 *
 * A browser cannot fetch a vendor's icon pack: the file is a `.zip`, and the
 * host does not permit cross-origin reads. The shell is under neither
 * restriction, so this is where "paste the link to the Azure pack" actually
 * works. That capability is worth fencing:
 *
 *  - https only, and never at the machine or the network it is running on. A
 *    renderer bug that reached this handler must not be able to use the shell
 *    as a probe for whatever is on the user's LAN.
 *  - What comes back is bytes, not trust. The renderer sanitises every SVG
 *    before it is stored or drawn, exactly as it does for a file from disk.
 *  - Sizes are capped at every step, because a zip is an invitation to send
 *    far more than was asked for.
 */
const MAX_DOWNLOAD_BYTES = 64_000_000;
const MAX_ICON_BYTES = 512_000;
const MAX_ICONS = 800;
const MAX_LINKS = 200;

/**
 * Whether a hostname points at this machine or the network it sits on.
 *
 * Not a complete defence — a name that resolves to a private address passes
 * this, and only the operating system knows for certain — but it refuses the
 * forms anyone would actually reach for.
 * @param {string} hostname
 */
function reachesLocalNetwork(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) {
    // IPv6: loopback, link-local, and the unique-local block.
    return host === "::1" || host.startsWith("fe80:") || /^f[cd]/.test(host);
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Fetch a URL, refusing to hold more than the cap.
 *
 * Read in chunks rather than in one `arrayBuffer()`: a server that declares
 * no length, or lies about it, would otherwise decide how much memory this
 * process uses.
 * @param {URL} url
 * @returns {Promise<Buffer | null>}
 */
async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) return null;

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      // Stop the transfer rather than draining it politely.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * A zip begins `PK`; a vendor's pack is one, a single icon is not.
 * @param {Buffer} buffer
 */
function looksZipped(buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * Every SVG in a zip, keeping the folders it arrived in.
 *
 * The path is not decoration: the renderer reads the vendor off it, so
 * `Azure_Public_Service_Icons/Icons/networking/…` is filed under Azure and
 * not into one undifferentiated heap. It reduces the path to a name itself.
 * @param {Buffer} buffer
 */
function iconsFromZip(buffer) {
  let taken = 0;
  const files = unzipSync(buffer, {
    // Decided before decompression, so an entry that claims to be enormous
    // is never expanded.
    filter: (file) => {
      if (taken >= MAX_ICONS) return false;
      if (!file.name.toLowerCase().endsWith(".svg")) return false;
      if (file.originalSize > MAX_ICON_BYTES) return false;
      taken++;
      return true;
    },
  });
  return Object.entries(files).map(([name, bytes]) => ({
    name,
    svg: Buffer.from(bytes).toString("utf8"),
  }));
}

function registerIpc() {
  // The renderer's theme is CSS, which reaches only what the page paints. The
  // widgets Chromium draws itself — the option list a <select> pops up, the
  // native dialogs, the scrollbars — follow the *app's* theme, and that
  // defaults to whatever Windows is set to. A dark Archyne on a light Windows
  // therefore opened a white option list. Told here, they match the app.
  ipcMain.on("archyne:set-theme", (_event, theme) => {
    nativeTheme.themeSource = theme === "light" ? "light" : "dark";
  });

  ipcMain.handle("archyne:opened-file", async () => {
    if (!pendingFile) return null;
    const filePath = pendingFile;
    pendingFile = undefined; // hand it over exactly once
    return readFile(filePath);
  });

  ipcMain.handle("archyne:show-open", async (event, arg) => {
    // The sender's window can already be gone if the user closed it mid-call;
    // fall back to an app-modal dialog rather than crashing.
    const win = BrowserWindow.fromWebContents(event.sender);
    // Import offers the foreign formats; Open offers only what Save writes.
    const filters = arg && arg.mode === "import" ? IMPORT_FILTERS : FILTERS;
    /** @type {import("electron").OpenDialogOptions} */
    const options = { properties: ["openFile"], filters };
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return null;
    return readFile(filePaths[0]);
  });

  ipcMain.handle("archyne:show-save", async (event, { defaultPath, content }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath, filters: FILTERS };
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, content, "utf8");
    return filePath;
  });

  // Reading a file the renderer already holds a path for: no dialog, and no
  // new capability — the path can only have come from an open or save the
  // user went through.
  ipcMain.handle("archyne:stat-file", async (_event, { path: filePath }) => {
    try {
      const stat = await fsp.stat(filePath);
      return { mtimeMs: stat.mtimeMs };
    } catch {
      return null; // moved, deleted, or being written to
    }
  });

  ipcMain.handle("archyne:read-file", async (_event, { path: filePath }) => {
    try {
      return await fsp.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  });

  ipcMain.handle("archyne:write-file", async (_event, { path: filePath, content }) => {
    await fsp.writeFile(filePath, content, "utf8");
  });

  // Icons from pasted links: one `.svg`, or a vendor's whole `.zip`. See the
  // notes above `MAX_DOWNLOAD_BYTES` for what this is allowed to reach.
  ipcMain.handle("archyne:fetch-icons", async (_event, { urls }) => {
    const icons = [];
    const failed = [];

    for (const link of (Array.isArray(urls) ? urls : []).slice(0, MAX_LINKS)) {
      try {
        const url = new URL(String(link));
        if (url.protocol !== "https:" || reachesLocalNetwork(url.hostname)) {
          failed.push(link);
          continue;
        }

        const body = await download(url);
        if (!body) {
          failed.push(link);
          continue;
        }

        const got = looksZipped(body)
          ? iconsFromZip(body)
          : [{ name: decodeURIComponent(url.pathname), svg: body.toString("utf8") }];
        if (got.length === 0) failed.push(link);
        else icons.push(...got);
      } catch {
        // Unreachable, malformed, not a zip after all: the renderer only
        // needs to know which links produced nothing.
        failed.push(link);
      }
      if (icons.length >= MAX_ICONS) break;
    }

    return { icons: icons.slice(0, MAX_ICONS), failed };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const file = fileArg(argv.slice(1));
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      // Reuse the running window rather than stacking another one up.
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      if (file) {
        void readFile(file).then((payload) =>
          existing.webContents.send("archyne:open-file", payload),
        );
      }
      return;
    }
    createWindow(file);
  });

  void app.whenReady().then(() => {
    registerIpc();
    registerAiIpc();
    createWindow(fileArg(process.argv.slice(1)));
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
