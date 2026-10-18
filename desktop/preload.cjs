/**
 * Bridge between the sandboxed renderer and the main process.
 *
 * The renderer previously received an opened file as a URL query string
 * (`?code=…`), which broke on large diagrams and threw away the file's path,
 * so open-edit-save could never write back to the original. This exposes a
 * narrow, explicit API instead: read the file we were launched with, and
 * write back to a known path.
 *
 * Only the calls below cross the boundary — `contextIsolation` and `sandbox`
 * stay on.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("archyne", {
  /** File passed on the command line, if any. Resolves once, at startup. */
  openedFile: () => ipcRenderer.invoke("archyne:opened-file"),

  /**
   * A second instance handed us a file, or the user used the app menu.
   * @param {(file: { path: string, content: string }) => void} callback
   */
  onOpenFile: (callback) => {
    ipcRenderer.on("archyne:open-file", (_event, file) => callback(file));
  },

  /**
   * Native open dialog. Returns `{ path, content }`, or null if cancelled.
   * `mode` picks the filter list: "open" offers Mermaid, "import" the
   * foreign formats.
   * @param {"open" | "import"} [mode]
   */
  showOpen: (mode) => ipcRenderer.invoke("archyne:show-open", { mode }),

  /**
   * Native save dialog. Returns the chosen path, or null if cancelled.
   * @param {string} defaultPath
   * @param {string} content
   */
  showSave: (defaultPath, content) =>
    ipcRenderer.invoke("archyne:show-save", { defaultPath, content }),

  /**
   * Overwrite a path the user has already chosen.
   * @param {string} path
   * @param {string} content
   */
  writeFile: (path, content) => ipcRenderer.invoke("archyne:write-file", { path, content }),
  /**
   * Modification time of a path already opened, for noticing edits made
   * outside the app — an agent writing through the MCP server edits the
   * same file the user has open.
   * @param {string} path
   */
  statFile: (path) => ipcRenderer.invoke("archyne:stat-file", { path }),

  /**
   * Re-read a path already opened. No dialog, and no new capability: the
   * path can only have come from an open or save the user went through.
   * @param {string} path
   */
  readFile: (path) => ipcRenderer.invoke("archyne:read-file", { path }),

  /**
   * Tell the shell which theme the app is showing, so the parts Chromium
   * draws itself match it. Fire-and-forget: nothing waits on the answer.
   * @param {"dark" | "light"} theme
   */
  setTheme: (theme) => ipcRenderer.send("archyne:set-theme", theme),

  /**
   * Download icons from links the user pasted. The shell does it because it
   * is not bound by CORS and can therefore take a vendor's `.zip`, which the
   * page cannot. Returns the icons it got and the links that gave nothing;
   * the renderer sanitises everything before it is stored or drawn.
   * @param {string[]} urls
   */
  fetchIcons: (urls) => ipcRenderer.invoke("archyne:fetch-icons", { urls }),

  /**
   * Generate through the shell (desktop/ai.cjs): the page describes the
   * services it may call and sends conversations; the shell keeps the
   * secrets, makes the requests and streams the answers back. A secret goes
   * in through `setSecret` and never comes out — `secretFields` only says
   * which are set.
   */
  ai: {
    /** @param {unknown[]} list */
    setConnections: (list) => ipcRenderer.invoke("archyne:ai-connections", list),
    /** @param {string} id @param {string} field @param {string | null} value */
    setSecret: (id, field, value) =>
      ipcRenderer.invoke("archyne:ai-secret", { id, field, value }),
    /** @param {string} id */
    secretFields: (id) => ipcRenderer.invoke("archyne:ai-secret-fields", { id }),
    canKeepSecrets: () => ipcRenderer.invoke("archyne:ai-can-keep-secrets"),
    /** @param {string} id */
    probe: (id) => ipcRenderer.invoke("archyne:ai-probe", { id }),
    /** @param {string} requestId @param {string} id @param {string} model @param {unknown[]} messages */
    chat: (requestId, id, model, messages) =>
      ipcRenderer.invoke("archyne:ai-chat", { requestId, id, model, messages }),
    /** @param {string} requestId */
    cancel: (requestId) => ipcRenderer.send("archyne:ai-cancel", { requestId }),
    /** @param {(event: unknown) => void} callback @returns {() => void} unsubscribe */
    onEvent: (callback) => {
      /** @param {Electron.IpcRendererEvent} _event @param {unknown} payload */
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("archyne:ai-event", listener);
      return () => ipcRenderer.removeListener("archyne:ai-event", listener);
    },
  },
});
