/**
 * The desktop host for Generate's remote and local-server engines.
 *
 * The page never holds a secret (AUTH.local.md, "The one rule"): it sends a
 * connection id and a conversation, and this process adds the credentials,
 * makes the request and streams the answer back over IPC. The logic itself
 * is shared with the VS Code extension and lives in src/ai/host, built to
 * dist-host/ai-host.cjs; this file only supplies what is particular to
 * Electron:
 *
 *   - secrets encrypted with `safeStorage` — the OS keychain on Windows and
 *     macOS, the desktop secret service on Linux — and written to a file in
 *     userData. Where the OS offers nothing better than a fixed key
 *     (`basic_text` on Linux without a keyring), secrets are refused rather
 *     than stored as good as plain;
 *   - `net.fetch`, Chromium's network stack, so a request honours the system
 *     proxy and the OS certificate store — what makes a company gateway behind
 *     a TLS-inspecting proxy reachable at all. Node's fetch does neither.
 */
const { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");

/** @type {import("../src/ai/host/index").AiHost | null} */
let host = null;

function secretsFile() {
  return path.join(app.getPath("userData"), "ai-secrets.json");
}

/** Whether this machine can encrypt secrets with something better than a fixed key. */
function canKeepSecrets() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (
    process.platform === "linux" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  ) {
    return false;
  }
  return true;
}

/** @returns {Promise<Record<string, string>>} key -> base64 of the encrypted value */
async function readStore() {
  try {
    return JSON.parse(await fsp.readFile(secretsFile(), "utf8"));
  } catch {
    return {};
  }
}

/** @param {Record<string, string>} store */
async function writeStore(store) {
  const file = secretsFile();
  // Written beside and renamed over, so a crash mid-write never leaves half a
  // file — and with it every saved secret — behind.
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  // Windows refuses a rename over a file something else has open for a
  // moment — an antivirus scanning what was just written. Try again briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(temp, file);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES"))
        throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

/**
 * The store as this process knows it: read from the file once, then kept
 * here and written back on each change. This process is the file's only
 * user, and a read never opening the file is what lets a write's rename
 * through on Windows.
 * @type {Promise<Record<string, string>> | null}
 */
let loaded = null;
function store() {
  loaded ??= readStore();
  return loaded;
}

/**
 * One change at a time, each written before the next is made: two writes at
 * once would race for the same temporary file.
 */
let changing = Promise.resolve();
/** @param {(store: Record<string, string>) => boolean} change true when the store changed */
function changeStore(change) {
  const next = changing.then(async () => {
    const current = await store();
    if (change(current)) await writeStore(current);
  });
  changing = next.catch(() => undefined);
  return next;
}

/** @type {import("../src/ai/host/index").SecretStore} */
const secrets = {
  async get(key) {
    const sealed = (await store())[key];
    if (!sealed || !canKeepSecrets()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      // Encrypted under another user or machine: as good as absent.
      return undefined;
    }
  },
  async set(key, value) {
    if (!canKeepSecrets()) {
      throw new Error("This system offers no secure storage for secrets.");
    }
    const sealed = safeStorage.encryptString(value).toString("base64");
    await changeStore((current) => {
      current[key] = sealed;
      return true;
    });
  },
  async delete(key) {
    await changeStore((current) => {
      if (!(key in current)) return false;
      delete current[key];
      return true;
    });
  },
};

/**
 * The shared host, loaded on first use so a missing build fails loudly and late.
 * @returns {import("../src/ai/host/index").AiHost}
 */
function aiHost() {
  if (host) return host;
  let mod;
  try {
    mod = require(path.join(__dirname, "..", "dist-host", "ai-host.cjs"));
  } catch {
    throw new Error("dist-host/ai-host.cjs is missing: run `npm run build` first.");
  }
  /** @type {import("../src/ai/host/index").AiHost} */
  const created = new mod.AiHost({
    fetch: /** @type {typeof fetch} */ ((input, init) => net.fetch(String(input), init)),
    secrets,
    // OAuth sign-in happens in the system browser, never in a window of
    // ours (RFC 8252: the app must not see the password). Only web addresses
    // are handed over — never a file: or custom scheme.
    openExternal: async (/** @type {string} */ url) => {
      const { protocol } = new URL(url);
      if (protocol !== "https:" && protocol !== "http:") throw new Error("Not a web address.");
      await shell.openExternal(url);
    },
    // Before a secret from a vault first goes somewhere: asked here, in a
    // window of the shell's own, which the page can neither draw nor answer.
    // "Don't allow" is what Enter and Escape choose.
    confirm: async (/** @type {import("../src/ai/host/index").AskText} */ text) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        type: /** @type {const} */ ("question"),
        title: text.title,
        message: text.message,
        detail: text.detail,
        buttons: [text.deny, text.allow],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const { response } = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      return response === 1;
    },
    // A certificate or key from a file: the shell's own dialog, and the
    // shell reads the file, so the page sees neither the path nor the bytes.
    pickFile: async (/** @type {{ title: string, extensions: string[] }} */ request) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: request.title,
        properties: /** @type {Array<"openFile">} */ (["openFile"]),
        filters: [
          {
            name: request.extensions.map((e) => e.toUpperCase()).join(", "),
            extensions: request.extensions,
          },
          { name: "*", extensions: ["*"] },
        ],
      };
      const { canceled, filePaths } = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (canceled || !filePaths[0]) return null;
      const file = filePaths[0];
      const { size } = await fsp.stat(file);
      return { name: path.basename(file), size, read: () => fsp.readFile(file) };
    },
  });
  host = created;
  return created;
}

/**
 * Only the app's own page may drive this: it is loaded from a file, and a
 * frame from anywhere else (a navigation gone wrong, an injected iframe)
 * gets nothing.
 */
/** @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} event */
function fromApp(event) {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith("file://");
}

function registerAiIpc() {
  ipcMain.handle("archyne:ai-connections", async (event, list, locale) => {
    if (!fromApp(event)) return;
    await aiHost().setConnections(Array.isArray(list) ? list : [], locale);
  });
  ipcMain.handle("archyne:ai-secret", async (event, { id, field, value }) => {
    if (!fromApp(event)) return;
    await aiHost().setSecret(String(id), String(field), value === null ? null : String(value));
  });
  ipcMain.handle("archyne:ai-secret-fields", async (event, { id }) => {
    if (!fromApp(event)) return [];
    return aiHost().secretFields(String(id));
  });
  ipcMain.handle("archyne:ai-can-keep-secrets", (event) => fromApp(event) && canKeepSecrets());
  ipcMain.handle("archyne:ai-probe", async (event, { id }) => {
    if (!fromApp(event)) return { state: "invalid", problem: "unknown" };
    return aiHost().probe(String(id));
  });
  ipcMain.handle("archyne:ai-chat", async (event, { requestId, id, model, messages }) => {
    if (!fromApp(event)) return;
    const sender = event.sender;
    await aiHost().chat(String(requestId), String(id), String(model), messages, (e) => {
      if (!sender.isDestroyed()) sender.send("archyne:ai-event", e);
    });
  });
  ipcMain.on("archyne:ai-cancel", (event, { requestId }) => {
    if (!fromApp(event)) return;
    aiHost().cancel(String(requestId));
  });
  // OAuth: progress (a device code, then signed in or not) streams as
  // `archyne:ai-event` like a chat's text; the tokens stay in this process.
  ipcMain.handle("archyne:ai-sign-in", async (event, { id }) => {
    if (!fromApp(event)) return;
    const sender = event.sender;
    await aiHost().signIn(String(id), (e) => {
      if (!sender.isDestroyed()) sender.send("archyne:ai-event", e);
    });
  });
  ipcMain.on("archyne:ai-cancel-sign-in", (event, { id }) => {
    if (!fromApp(event)) return;
    aiHost().cancelSignIn(String(id));
  });
  ipcMain.handle("archyne:ai-sign-out", async (event, { id }) => {
    if (!fromApp(event)) return;
    await aiHost().signOut(String(id));
  });
  ipcMain.handle("archyne:ai-auth-status", async (event, { id }) => {
    if (!fromApp(event)) return { signedIn: false };
    return aiHost().authStatus(String(id));
  });
  ipcMain.handle("archyne:ai-import-secret", async (event, { id, field }) => {
    if (!fromApp(event)) return { problem: "invalid" };
    return aiHost().importSecretFile(String(id), String(field));
  });
}

module.exports = { registerAiIpc };
