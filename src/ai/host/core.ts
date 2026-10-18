import {
  isHostReachableUrl,
  probeServer,
  serverProvider,
  ServerError,
  type Reachability,
} from "../server";
import type { ChatMessage } from "../types";
import {
  authHeaders,
  connectionProblem,
  PAGE_SETTABLE_SECRETS,
  SECRET_FIELDS,
  secretFieldsOf,
  type Connection,
  type OAuthConfig,
} from "./connection";
import { nodeLoopback } from "./loopback";
import { mtlsFetch } from "./mtls";
import {
  accessToken,
  authStatus,
  signIn,
  signOut,
  type Loopback,
  type OAuthEnv,
  type OAuthSecrets,
} from "./oauth";

/**
 * The half of Generate that runs in a host process — Electron's main process
 * or VS Code's extension host — where secrets can be kept and any address can
 * be reached. The page sends it a connection id and a conversation; it adds
 * the credentials, makes the request and streams the answer back. It never
 * hands a secret to the page — not a key, not a password, not a token.
 *
 * Environment-neutral on purpose: it takes its `fetch`, its secret store and
 * its way of opening a browser from the host that runs it, so the desktop app
 * and the extension share one implementation, and the tests drive it with
 * scripted ones.
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
  /** Opens the system browser, for OAuth sign-in. */
  openExternal?: (url: string) => Promise<void>;
  /** The browser's way back from a sign-in; a real loopback listener by default. */
  loopback?: () => Promise<Loopback>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What the host sends back to the page: a request's text, or a sign-in's progress. */
export type HostEvent =
  | { type: "ai:chunk"; requestId: string; text: string }
  | { type: "ai:done"; requestId: string; text: string }
  | { type: "ai:error"; requestId: string; reason: string; detail: string }
  | {
      type: "ai:auth";
      connectionId: string;
      state: "device-code";
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
    }
  | {
      type: "ai:auth";
      connectionId: string;
      state: "signed-in" | "signed-out" | "error";
      detail?: string;
    };

/** The key a secret is filed under; one namespace per connection. */
export function secretKey(connectionId: string, field: string): string {
  return `archyne.ai.${connectionId}.${field}`;
}

export class AiHost {
  private connections = new Map<string, Connection>();
  private running = new Map<string, AbortController>();
  private signingIn = new Map<string, AbortController>();

  constructor(private readonly env: HostEnv) {}

  /**
   * Replace the list of connections. The secrets of a connection that is no
   * longer listed are deleted, so removing a service in the panel really
   * removes its key — or its tokens — rather than leaving them in the keychain.
   */
  async setConnections(list: Connection[]): Promise<void> {
    const next = new Map(list.filter(isConnection).map((c) => [c.id, c]));
    for (const [id, old] of this.connections) {
      if (next.has(id)) continue;
      for (const field of secretFieldsOf(old)) {
        await this.env.secrets.delete(secretKey(id, field));
      }
    }
    this.connections = next;
  }

  /**
   * Store, replace (`value`) or forget (`null`) one secret a person typed.
   * Tokens and registered clients are not among them: only the host's own
   * flows write those, so a page can never plant one.
   */
  async setSecret(connectionId: string, field: string, value: string | null): Promise<void> {
    if (!PAGE_SETTABLE_SECRETS.has(field)) throw new Error("Not a secret field.");
    const key = secretKey(connectionId, field);
    if (value === null || value === "") await this.env.secrets.delete(key);
    else await this.env.secrets.set(key, value);
  }

  /** Which of a connection's typed secrets are set — the page shows "saved", never the value. */
  async secretFields(connectionId: string): Promise<string[]> {
    const c = this.connections.get(connectionId);
    if (!c) return [];
    const set: string[] = [];
    for (const field of secretFieldsOf(c)) {
      if (!PAGE_SETTABLE_SECRETS.has(field)) continue;
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
    return probeServer({ baseUrl: c.baseUrl, model: "" }, this.fetchFor(c), isHostReachableUrl);
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
        this.fetchFor(c),
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
   * Sign a person in to an OAuth connection. Progress (a device code to show,
   * then signed in or not) goes to `emit`; the tokens stay here.
   */
  async signIn(connectionId: string, emit: (event: HostEvent) => void): Promise<void> {
    const c = this.connections.get(connectionId);
    if (!c || c.auth.type !== "oauth" || connectionProblem(c)) {
      emit({ type: "ai:auth", connectionId, state: "error", detail: "invalid" });
      return;
    }
    this.signingIn.get(connectionId)?.abort();
    const ctrl = new AbortController();
    this.signingIn.set(connectionId, ctrl);
    const timeout = AbortSignal.timeout(5 * 60_000);
    try {
      await signIn(
        c.auth,
        c.baseUrl,
        this.oauthSecrets(c.id),
        this.oauthEnv(c),
        (prompt) => emit({ type: "ai:auth", connectionId, state: "device-code", ...prompt }),
        AbortSignal.any([ctrl.signal, timeout]),
      );
      emit({ type: "ai:auth", connectionId, state: "signed-in" });
    } catch (err) {
      emit({
        type: "ai:auth",
        connectionId,
        state: "error",
        detail: redact(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      if (this.signingIn.get(connectionId) === ctrl) this.signingIn.delete(connectionId);
    }
  }

  cancelSignIn(connectionId: string): void {
    this.signingIn.get(connectionId)?.abort();
  }

  async signOut(connectionId: string): Promise<void> {
    const c = this.connections.get(connectionId);
    if (!c || c.auth.type !== "oauth") return;
    await signOut(c.auth, c.baseUrl, this.oauthSecrets(c.id), this.oauthEnv(c));
  }

  async authStatus(connectionId: string): Promise<{ signedIn: boolean; expiresAt?: number }> {
    const c = this.connections.get(connectionId);
    if (!c || c.auth.type !== "oauth") return { signedIn: false };
    return authStatus(this.oauthSecrets(c.id));
  }

  /**
   * A `fetch` that carries the connection's credentials, and refuses to
   * follow a redirect: a 3xx to another host would otherwise be a way to have
   * the credential sent somewhere it was never meant to go.
   *
   * For OAuth the token is read — and refreshed if it is about to lapse — at
   * the moment of each request, and a 401 earns exactly one forced refresh
   * and retry: a token revoked early, or a clock that disagrees.
   */
  private fetchFor(c: Connection): typeof fetch {
    const headersFor = async (force: boolean) => {
      const secrets: Record<string, string | undefined> = {};
      for (const field of SECRET_FIELDS[c.auth.type]) {
        secrets[field] = await this.env.secrets.get(secretKey(c.id, field));
      }
      if (c.auth.type === "oauth") {
        const token = await accessToken(
          c.auth,
          c.baseUrl,
          this.oauthSecrets(c.id),
          this.oauthEnv(c),
          force,
        );
        secrets.tokens = token ? JSON.stringify({ access_token: token }) : undefined;
      }
      return authHeaders(c, secrets);
    };
    const send = async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      force: boolean,
    ) =>
      (await this.transportFor(c))(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(await headersFor(force)),
        },
        redirect: "error",
      });
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await send(input, init, false);
      if (response.status !== 401 || c.auth.type !== "oauth") return response;
      return send(input, init, true);
    }) as typeof fetch;
  }

  private oauthSecrets(connectionId: string): OAuthSecrets {
    const s = this.env.secrets;
    return {
      get: (field) => s.get(secretKey(connectionId, field)),
      set: (field, value) => s.set(secretKey(connectionId, field), value),
      delete: (field) => s.delete(secretKey(connectionId, field)),
    };
  }

  /**
   * How this connection's requests travel: the platform fetch, or — when it
   * presents a client certificate — the mTLS transport, for the service and
   * its token endpoint alike.
   */
  private async transportFor(c: Connection): Promise<typeof fetch> {
    if (!c.clientCertificate) return this.env.fetch;
    const get = (field: string) => this.env.secrets.get(secretKey(c.id, field));
    const [cert, key, passphrase, ca] = await Promise.all(
      ["tlsCert", "tlsKey", "tlsPassphrase", "tlsCa"].map(get),
    );
    if (!cert || !key) throw new Error("A client certificate and its key are needed.");
    return mtlsFetch({ cert, key, passphrase, ca });
  }

  private oauthEnv(c: Connection): OAuthEnv {
    const env = this.env;
    return {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        (await this.transportFor(c))(input, init)) as typeof fetch,
      openExternal:
        env.openExternal ??
        (() => Promise.reject(new Error("This host cannot open a browser."))),
      loopback: env.loopback ?? nodeLoopback,
      now: env.now ?? Date.now,
      sleep: env.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }
}

/** An error message as the page may see it: never a token, even quoted back by a server. */
function redact(message: string): string {
  return message.replace(/(access_token|refresh_token|code|client_secret)=[^&\s"]+/g, "$1=…");
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

export type { OAuthConfig };
