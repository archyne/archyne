/**
 * The question window's only way to the shell (desktop/ai.cjs, askInWindow):
 * read the question, give one answer, ask for the height it needs. Nothing
 * else, and this window is not the app's page, so the page cannot reach it.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("archyneConfirm", {
  text: () => ipcRenderer.invoke("archyne:confirm-text"),
  /** @param {boolean} allowed */
  answer: (allowed) => ipcRenderer.send("archyne:confirm-answer", allowed === true),
  /** @param {number} height */
  fit: (height) => ipcRenderer.send("archyne:confirm-fit", Number(height) || 0),
});
