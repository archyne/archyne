import type { Translate } from "../i18n";
import { presetOf, SERVER_PRESETS, type ServerPreset } from "./server";

/**
 * The origin a server has to allow, as the person would type it into the
 * server's settings. A page opened from a file reports `null`, which no
 * server setting accepts; the desktop app is the case, and `file://*` is what
 * Ollama's own list uses for it.
 */
export function pageOrigin(): string {
  const origin = globalThis.location?.origin ?? "";
  return origin && origin !== "null" ? origin : "file://*";
}

/**
 * What to tell the person about a local server that could not be used, and
 * how to fix it — in the words of the server they actually run, because "turn
 * on CORS" means a different switch in Ollama than in LM Studio.
 */
export function serverAdvice(
  t: Translate,
  reason: string,
  baseUrl: string,
  status?: number,
): string {
  const preset: ServerPreset | null = presetOf(baseUrl);
  const name = preset ? SERVER_PRESETS[preset].label : t("ai.serverGeneric");
  switch (reason) {
    case "blocked":
      if (preset === "ollama") return t("ai.serverBlockedOllama", { origin: pageOrigin() });
      if (preset === "lmstudio") return t("ai.serverBlockedLmStudio");
      return t("ai.serverBlocked", { origin: pageOrigin() });
    case "down":
      return t("ai.serverDown", { url: baseUrl, server: name });
    case "not-local":
      return t("ai.serverNotLocal");
    case "no-model":
      return t("ai.serverNeedsModel");
    default:
      return t("ai.serverHttp", { status: status ?? "?" });
  }
}
