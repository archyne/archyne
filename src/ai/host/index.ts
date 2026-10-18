/**
 * The entry the host processes load, built to `dist-host/ai-host.cjs` by
 * `npm run build:host` (vite.host.config.ts). Electron's main process
 * requires it from the packaged app; the VS Code extension carries a copy
 * (extensions/vscode/scripts/bundle-app.mjs). One implementation, two hosts.
 */
export { AiHost, secretKey } from "./core";
export type { HostEnv, HostEvent, SecretStore } from "./core";
export type { Connection } from "./connection";
