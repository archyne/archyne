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
const { app, ipcMain, net, safeStorage } = require("electron");
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
  await fsp.rename(temp, file);
}

/** @type {import("../src/ai/host/index").SecretStore} */
const secrets = {
  async get(key) {
    const store = await readStore();
    if (!store[key] || !canKeepSecrets()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(store[key], "base64"));
    } catch {
      // Encrypted under another user or machine: as good as absent.
      return undefined;
    }
  },
  async set(key, value) {
    if (!canKeepSecrets()) {
      throw new Error("This system offers no secure storage for secrets.");
    }
    const store = await readStore();
    store[key] = safeStorage.encryptString(value).toString("base64");
    await writeStore(store);
  },
  async delete(key) {
    const store = await readStore();
    if (!(key in store)) return;
    delete store[key];
    await writeStore(store);
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
  ipcMain.handle("archyne:ai-connections", async (event, list) => {
    if (!fromApp(event)) return;
    await aiHost().setConnections(Array.isArray(list) ? list : []);
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
}

module.exports = { registerAiIpc };
