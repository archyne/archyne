import {
  isHostReachableUrl,
  probeServer,
  serverProvider,
  ServerError,
  type Reachability,
} from "../server";
import type { ChatMessage } from "../types";
import { authHeaders, connectionProblem, SECRET_FIELDS, type Connection } from "./connection";

/**
 * The half of Generate that runs in a host process — Electron's main process
 * or VS Code's extension host — where secrets can be kept and any address can
 * be reached. The page sends it a connection id and a conversation; it adds
 * the credentials, makes the request and streams the answer back. It never
 * hands a secret to the page.
 *
 * Environment-neutral on purpose: it takes its `fetch` and its secret store
 * from the host that runs it, so the desktop app and the extension share one
 * implementation, and the tests drive it with scripted ones.
 */

/** Where a host keeps secrets: the OS keychain via Electron, or VS Code's SecretStorage. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HostEnv {
  fetch: typeof fetch;
  secrets: SecretStore;
}

/** What the host sends back to the page while a request runs. */
export type HostEvent =
  | { type: "ai:chunk"; requestId: string; text: string }
  | { type: "ai:done"; requestId: string; text: string }
  | { type: "ai:error"; requestId: string; reason: string; detail: string };

/** The key a secret is filed under; one namespace per connection. */
export function secretKey(connectionId: string, field: string): string {
  return `archyne.ai.${connectionId}.${field}`;
}

export class AiHost {
  private connections = new Map<string, Connection>();
  private running = new Map<string, AbortController>();

  constructor(private readonly env: HostEnv) {}

  /**
   * Replace the list of connections. The secrets of a connection that is no
   * longer listed are deleted, so removing a service in the panel really
   * removes its key rather than leaving it in the keychain.
   */
  async setConnections(list: Connection[]): Promise<void> {
    const next = new Map(list.filter(isConnection).map((c) => [c.id, c]));
    for (const [id, old] of this.connections) {
      if (next.has(id)) continue;
      for (const field of SECRET_FIELDS[old.auth.type]) {
        await this.env.secrets.delete(secretKey(id, field));
      }
    }
    this.connections = next;
  }

  /** Store, replace (`value`) or forget (`null`) one secret of a connection. */
  async setSecret(connectionId: string, field: string, value: string | null): Promise<void> {
    if (!/^[a-z]+$/.test(field)) throw new Error("Not a secret field.");
    const key = secretKey(connectionId, field);
    if (value === null || value === "") await this.env.secrets.delete(key);
    else await this.env.secrets.set(key, value);
  }

  /** Which of a connection's secrets are set — the page shows "saved", never the value. */
  async secretFields(connectionId: string): Promise<string[]> {
    const c = this.connections.get(connectionId);
    if (!c) return [];
    const set: string[] = [];
    for (const field of SECRET_FIELDS[c.auth.type]) {
      if (await this.env.secrets.get(secretKey(connectionId, field))) set.push(field);
    }
    return set;
  }

  /** Reachability and the model list, as the local engine reports them. */
  async probe(
    connectionId: string,
  ): Promise<Reachability | { state: "invalid"; problem: string }> {
    const c = this.connections.get(connectionId);
    if (!c) return { state: "invalid", problem: "unknown" };
    const problem = connectionProblem(c);
    if (problem) return { state: "invalid", problem };
    return probeServer(
      { baseUrl: c.baseUrl, model: "" },
      await this.fetchFor(c),
      isHostReachableUrl,
    );
  }

  /** Answer one turn, streaming the running text through `emit`. */
  async chat(
    requestId: string,
    connectionId: string,
    model: string,
    messages: ChatMessage[],
    emit: (event: HostEvent) => void,
  ): Promise<void> {
    const c = this.connections.get(connectionId);
    const problem = c ? connectionProblem(c) : "unknown";
    if (!c || problem) {
      emit({ type: "ai:error", requestId, reason: "invalid", detail: problem ?? "unknown" });
      return;
    }
    const ctrl = new AbortController();
    this.running.set(requestId, ctrl);
    try {
      const provider = serverProvider(
        { baseUrl: c.baseUrl, model },
        await this.fetchFor(c),
        isHostReachableUrl,
      );
      const text = await provider.generate(messages, {
        signal: ctrl.signal,
        onToken: (running) => emit({ type: "ai:chunk", requestId, text: running }),
      });
      emit({ type: "ai:done", requestId, text });
    } catch (err) {
      if (ctrl.signal.aborted) {
        emit({ type: "ai:error", requestId, reason: "aborted", detail: "" });
      } else {
        emit({
          type: "ai:error",
          requestId,
          reason: err instanceof ServerError ? err.reason : "network",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.running.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort();
  }

  /**
   * A `fetch` that carries the connection's credentials, and refuses to
   * follow a redirect: a 3xx to another host would otherwise be a way to have
   * the credential sent somewhere it was never meant to go.
   */
  private async fetchFor(c: Connection): Promise<typeof fetch> {
    const secrets: Record<string, string | undefined> = {};
    for (const field of SECRET_FIELDS[c.auth.type]) {
      secrets[field] = await this.env.secrets.get(secretKey(c.id, field));
    }
    const auth = authHeaders(c, secrets);
    const base = this.env.fetch;
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      base(input, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), ...auth },
        redirect: "error",
      })) as typeof fetch;
  }
}

/** A loose structural check: a page is not trusted to send the right shape. */
function isConnection(value: unknown): value is Connection {
  const c = value as Partial<Connection> | null;
  return (
    !!c &&
    typeof c.id === "string" &&
    typeof c.baseUrl === "string" &&
    typeof c.protocol === "string" &&
    !!c.auth &&
    typeof c.auth.type === "string" &&
    c.auth.type in SECRET_FIELDS
  );
}
