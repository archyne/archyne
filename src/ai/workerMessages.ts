/**
 * What the page and the generation worker say to each other.
 *
 * In its own file on purpose: the worker must not import the module that
 * *creates* workers, or building one would pull a second one in behind it.
 * Both sides import these types and nothing else of each other's.
 *
 * Everything here has to survive `postMessage`, so it is plain data — no
 * `AbortSignal`, no callbacks, no class instances. Cancelling is a message
 * like any other, which is the whole reason the protocol carries a run id.
 */
import type { LocalStatus } from "./transformers";
import type { AiModel, ChatMessage } from "./types";

export type MainToWorker =
  /** Answered with `pong`, to prove the round trip before trusting it. */
  | { type: "ping" }
  | { type: "generate"; run: number; chat: ChatMessage[]; model: AiModel }
  /** Stop this run; the worker answers with an `error` naming the abort. */
  | { type: "cancel"; run: number };

export type WorkerToMain =
  | { type: "pong" }
  /** The engine's loading progress, forwarded verbatim to the panel. */
  | { type: "status"; status: LocalStatus }
  /** The answer so far, as the streamer hands it over. */
  | { type: "token"; run: number; text: string }
  | { type: "done"; run: number; text: string }
  /** `name` is carried separately so an AbortError survives the crossing. */
  | { type: "error"; run: number; message: string; name: string };
