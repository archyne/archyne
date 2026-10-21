import {
  isHostReachableUrl,
  probeServer,
  serverProvider,
  ServerError,
  type Reachability,
} from "../server";
import type { ChatMessage } from "../types";
import {
  ALL_SECRET_FIELDS,
  authHeaders,
  credentialTarget,
  parseTokens,
  connectionProblem,
  PAGE_SETTABLE_SECRETS,
  SECRET_FIELDS,
  secretFieldsOf,
  type Connection,
  type OAuthConfig,
} from "./connection";
import { nodeRunCli, type RunCli } from "./cli";
import { dialectFor } from "./dialects";
import { nodeLoopback } from "./loopback";
import { mtlsFetch } from "./mtls";
import { signRequest } from "./sigv4";
import {
  cliCall,
  pick,
  refProblem,
  vaultIdentity,
  vaultProblem,
  type SecretRef,
} from "./vault";
import { FILE_EXTENSIONS, FILE_FIELDS, MAX_FILE_BYTES, readSecretFile } from "./secretFile";
import { askText, fieldName, type AskText, type VaultAsk } from "./vaultAsk";
import {
  accessToken,
  dpopRequest,
  authStatus,
  signIn,
  signOut,
  whyFailed,
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
  /** Runs a vendor's CLI, to read a secret from a vault; the real one by default. */
  runCli?: RunCli;
  /**
   * Asks the person, in the host's own window, whether a secret from a vault
   * may go where a connection would send it. Without it, none is sent.
   */
  confirm?: (text: AskText, ask: VaultAsk) => Promise<boolean>;
  /**
   * Lets the person choose a file, in the host's own dialog, for a
   * certificate or a key; null when they cancel. The page never sees the
   * file, its name, or its contents.
   */
  pickFile?: (request: { title: string; extensions: string[] }) => Promise<PickedFile | null>;
}

/** A file the person chose: its name, its size, and a way to read it. */
export interface PickedFile {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}

/** What loading a file into a secret field came to — never the contents. */
export type ImportResult =
  | { saved: string[] }
  | { cancelled: true }
  | {
      problem:
        "too-large" | "empty" | "not-certificate" | "not-key" | "unsupported" | "invalid";
    };

/** A vault could not give a secret: not signed in, no such secret, refused. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
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

/** Where a connection's secrets were kept for: its `credentialTarget` when they were. */
const BOUND_TO = "boundTo";

/** The vault secrets a person has let a connection send, and where. */
const APPROVALS = "approvals";

/** How long a secret read from a vault is kept in memory before it is read again. */
const VAULT_TTL_MS = 30 * 60_000;

/** The key a secret is filed under; one namespace per connection. */
export function secretKey(connectionId: string, field: string): string {
  return `archyne.ai.${connectionId}.${field}`;
}

export class AiHost {
  private connections = new Map<string, Connection>();
  private running = new Map<string, AbortController>();
  private signingIn = new Map<string, AbortController>();
  /**
   * Changes to the connections and their secrets, one at a time and in the
   * order they came; what reads them waits for those already asked for, so a
   * check right after a key is typed sees the key.
   */
  private changes: Promise<unknown> = Promise.resolve();
  /** Secrets read from vaults, in memory only, by connection and field. */
  private vaultCache = new Map<string, { value: string; at: number; identity: string }>();
  private vaultReads = new Map<string, Promise<string>>();
  /** One question to the person at a time. */
  private asking: Promise<unknown> = Promise.resolve();
  /** The page's language, for the questions the host asks in its own window. */
  private locale = "en";

  constructor(private readonly env: HostEnv) {}

  private change<T>(run: () => Promise<T>): Promise<T> {
    const next = this.changes.then(run);
    this.changes = next.catch(() => undefined);
    return next;
  }

  private settled(): Promise<unknown> {
    return this.changes;
  }

  /**
   * Replace the list of connections. The secrets of a connection that is no
   * longer listed are deleted, so removing a service in the panel really
   * removes its key — or its tokens — rather than leaving them in the keychain.
   *
   * What a connection keeps is bound to where it was kept for (its
   * `credentialTarget`, filed beside the secrets when the first is kept, so
   * it outlives a restart). The page owns the connection's address; were a
   * moved address to keep its secrets, a page could send a saved key or token
   * to any host it chose. Moved, then, the connection starts again with none.
   */
  setConnections(list: Connection[], locale?: unknown): Promise<void> {
    if (typeof locale === "string" && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale)) {
      this.locale = locale;
    }
    return this.change(async () => {
      const next = new Map(list.filter(isConnection).map((c) => [c.id, c]));
      for (const id of this.connections.keys()) {
        if (!next.has(id)) await this.forget(id);
      }
      for (const c of next.values()) {
        const bound = await this.env.secrets.get(secretKey(c.id, BOUND_TO));
        if (bound === undefined || bound === credentialTarget(c)) continue;
        this.signingIn.get(c.id)?.abort();
        await this.forget(c.id);
      }
      this.connections = next;
    });
  }

  /** File a connection's binding before the first secret it keeps. */
  private async bind(connectionId: string): Promise<void> {
    const c = this.connections.get(connectionId);
    if (!c) throw new Error("No such connection.");
    const key = secretKey(connectionId, BOUND_TO);
    if ((await this.env.secrets.get(key)) === undefined) {
      await this.env.secrets.set(key, credentialTarget(c));
    }
  }

  /** Delete everything filed for a connection, whatever its auth method was. */
  private async forget(connectionId: string): Promise<void> {
    this.evict(connectionId);
    for (const field of [...ALL_SECRET_FIELDS, APPROVALS, BOUND_TO]) {
      await this.env.secrets.delete(secretKey(connectionId, field));
    }
  }

  /**
   * One of a connection's typed secrets: kept here, or read from a vault.
   * A vault's is read when first needed, after the person has allowed it to
   * go where this connection sends it, and is then kept in memory for a
   * while — never in the store.
   */
  private async secret(c: Connection, field: string): Promise<string | undefined> {
    const ref = c.fromVault?.[field];
    if (!ref) return this.env.secrets.get(secretKey(c.id, field));
    const v = this.connections.get(ref.vault);
    if (!v || v.protocol !== "vault") {
      throw new VaultError("The vault this secret is read from is not set up.");
    }
    const problem = vaultProblem(v) ?? refProblem(v, ref);
    if (problem)
      throw new VaultError(`The vault or the secret's name is not valid (${problem}).`);
    const identity = JSON.stringify([
      credentialTarget(c),
      vaultIdentity(v),
      ref.name,
      ref.key ?? "",
    ]);
    const slot = `${c.id}\u0000${field}`;
    const now = (this.env.now ?? Date.now)();
    const cached = this.vaultCache.get(slot);
    if (cached && cached.identity === identity && now - cached.at < VAULT_TTL_MS) {
      return cached.value;
    }
    const pending = `${slot}\u0000${identity}`;
    let reading = this.vaultReads.get(pending);
    if (!reading) {
      reading = this.readVault(c, field, v, ref, identity).finally(() =>
        this.vaultReads.delete(pending),
      );
      this.vaultReads.set(pending, reading);
    }
    const value = await reading;
    this.vaultCache.set(slot, { value, at: now, identity });
    return value;
  }

  private async readVault(
    c: Connection,
    field: string,
    v: Connection,
    ref: SecretRef,
    identity: string,
  ): Promise<string> {
    await this.approve(c, field, v, ref, identity);
    let raw: string;
    try {
      if (v.vault!.via === "cli") {
        const call = cliCall(v, ref);
        raw = call.read(await (this.env.runCli ?? nodeRunCli)(call));
      } else {
        throw new Error("Reading this vault through a sign-in is not available yet.");
      }
      return pick(v, ref, raw);
    } catch (err) {
      throw new VaultError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Ask once — in the host's window — before a vault's secret first goes to
   * this connection's address as this field. The answer is filed with the
   * connection's secrets, so it is bound like them and lapses when the
   * connection is pointed elsewhere.
   */
  private approve(
    c: Connection,
    field: string,
    v: Connection,
    ref: SecretRef,
    identity: string,
  ): Promise<void> {
    const run = async () => {
      const key = secretKey(c.id, APPROVALS);
      let approved: string[] = [];
      try {
        const stored: unknown = JSON.parse((await this.env.secrets.get(key)) ?? "[]");
        if (Array.isArray(stored)) approved = stored.filter((x) => typeof x === "string");
      } catch {
        // Unreadable: as if nothing had been allowed.
      }
      const entry = JSON.stringify([identity, field]);
      if (approved.includes(entry)) return;
      if (!this.env.confirm) {
        throw new VaultError("This host cannot ask before sending a secret from a vault.");
      }
      let destination = c.baseUrl;
      try {
        destination = new URL(c.baseUrl).origin;
      } catch {
        // Shown as typed.
      }
      const ask: VaultAsk = {
        secret: ref.key ? `${ref.name} › ${ref.key}` : ref.name,
        vault: v.label || v.baseUrl,
        destination,
        field,
      };
      const allowed = await this.env.confirm(askText(this.locale, ask), ask);
      if (!allowed) throw new VaultError("Sending that secret from the vault was not allowed.");
      try {
        await this.bind(c.id);
        await this.env.secrets.set(key, JSON.stringify([...approved, entry]));
      } catch {
        // A store that keeps nothing: allowed this time, asked again next.
      }
    };
    const next = this.asking.then(run);
    this.asking = next.catch(() => undefined);
    return next;
  }

  /**
   * Read, ahead of a request, every secret this connection takes from a
   * vault — so that a vault that cannot give one is reported as that, in the
   * CLI's or the vault's own words, and not as a service that did not answer.
   */
  private async vaultSecrets(c: Connection): Promise<void> {
    const used = new Set(secretFieldsOf(c));
    for (const field of Object.keys(c.fromVault ?? {})) {
      if (used.has(field) && PAGE_SETTABLE_SECRETS.has(field)) await this.secret(c, field);
    }
  }

  /** Forget what was read from vaults for a connection; true if there was anything. */
  private evict(connectionId: string): boolean {
    let any = false;
    for (const slot of this.vaultCache.keys()) {
      if (slot.startsWith(`${connectionId}\u0000`)) {
        this.vaultCache.delete(slot);
        any = true;
      }
    }
    return any;
  }

  /**
   * Store, replace (`value`) or forget (`null`) one secret a person typed.
   * Tokens and registered clients are not among them: only the host's own
   * flows write those, so a page can never plant one.
   */
  setSecret(connectionId: string, field: string, value: string | null): Promise<void> {
    if (!PAGE_SETTABLE_SECRETS.has(field))
      return Promise.reject(new Error("Not a secret field."));
    return this.change(async () => {
      const key = secretKey(connectionId, field);
      if (value === null || value === "") return this.env.secrets.delete(key);
      await this.bind(connectionId);
      await this.env.secrets.set(key, value);
    });
  }

  /**
   * Load a certificate or a key from a file the person chooses in the host's
   * own dialog. The contents are checked for what the field needs and kept
   * like a typed secret; the page learns only which fields were saved. A
   * PKCS#12 bundle stands for the certificate and its key, so keeping one
   * drops the other, either way.
   */
  async importSecretFile(connectionId: string, field: string): Promise<ImportResult> {
    if (!FILE_FIELDS.has(field)) return { problem: "invalid" };
    await this.settled();
    if (!this.connections.has(connectionId)) return { problem: "invalid" };
    if (!this.env.pickFile) return { problem: "unsupported" };
    const picked = await this.env.pickFile({
      title: `Archyne — ${fieldName(this.locale, field)}`,
      extensions: FILE_EXTENSIONS[field],
    });
    if (!picked) return { cancelled: true };
    if (picked.size > MAX_FILE_BYTES) return { problem: "too-large" };
    const read = readSecretFile(field, picked.name, await picked.read());
    if ("problem" in read) return read;
    const saved = read.secrets.map((s) => s.field);
    const replaced = saved.includes("tlsPfx")
      ? ["tlsCert", "tlsKey"]
      : saved.some((f) => f === "tlsCert" || f === "tlsKey")
        ? ["tlsPfx"]
        : [];
    await this.change(async () => {
      await this.bind(connectionId);
      for (const { field: f, value } of read.secrets) {
        await this.env.secrets.set(secretKey(connectionId, f), value);
      }
      for (const f of replaced) await this.env.secrets.delete(secretKey(connectionId, f));
    });
    return { saved };
  }

  /** Which of a connection's typed secrets are set — the page shows "saved", never the value. */
  async secretFields(connectionId: string): Promise<string[]> {
    await this.settled();
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
  ): Promise<
    Reachability | { state: "invalid"; problem: string } | { state: "vault"; detail: string }
  > {
    await this.settled();
    const c = this.connections.get(connectionId);
    if (!c) return { state: "invalid", problem: "unknown" };
    const problem = connectionProblem(c);
    if (problem) return { state: "invalid", problem };
    try {
      await this.vaultSecrets(c);
    } catch (err) {
      return { state: "vault", detail: err instanceof Error ? err.message : String(err) };
    }
    return probeServer(
      { baseUrl: c.baseUrl, model: "" },
      this.fetchFor(c),
      isHostReachableUrl,
      dialectFor(c.protocol) ?? undefined,
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
    // Registered before waiting, so a cancel that comes meanwhile is not lost.
    const ctrl = new AbortController();
    this.running.set(requestId, ctrl);
    await this.settled();
    const c = this.connections.get(connectionId);
    const problem = c ? connectionProblem(c) : "unknown";
    if (!c || problem) {
      this.running.delete(requestId);
      emit({ type: "ai:error", requestId, reason: "invalid", detail: problem ?? "unknown" });
      return;
    }
    try {
      if (ctrl.signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
      await this.vaultSecrets(c);
      const provider = serverProvider(
        { baseUrl: c.baseUrl, model },
        this.fetchFor(c),
        isHostReachableUrl,
        dialectFor(c.protocol) ?? undefined,
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
          reason:
            err instanceof ServerError
              ? err.reason
              : err instanceof VaultError
                ? "vault"
                : "network",
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
    await this.settled();
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
        detail: redact(whyFailed(err)),
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
    await this.settled();
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
        secrets[field] = PAGE_SETTABLE_SECRETS.has(field)
          ? await this.secret(c, field)
          : await this.env.secrets.get(secretKey(c.id, field));
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
    ) => {
      const headers = {
        ...(init?.headers as Record<string, string> | undefined),
        ...(await headersFor(force)),
      };
      // A DPoP-bound token goes with a proof of the key, not as a bearer
      // token. Decided by what the server issued: one that does not do DPoP
      // hands out bearer tokens, and those go the ordinary way.
      if (c.auth.type === "oauth" && c.auth.dpop) {
        const stored = parseTokens(await this.env.secrets.get(secretKey(c.id, "tokens")));
        if (stored && stored.token_type?.toLowerCase() === "dpop") {
          return dpopRequest(
            c.auth,
            this.oauthSecrets(c.id),
            this.oauthEnv(c),
            stored.access_token,
            input,
            {
              ...init,
              headers,
            },
          );
        }
      }
      if (c.auth.type === "sigv4") {
        return (await this.transportFor(c))(input, {
          ...init,
          headers: await this.signed(c, c.auth, String(input), init, headers),
          redirect: "error",
        });
      }
      return (await this.transportFor(c))(input, { ...init, headers, redirect: "error" });
    };
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await send(input, init, false);
      if (response.status !== 401) return response;
      // A key rotated in its vault: read it again, and try once more.
      const reread = this.evict(c.id);
      if (c.auth.type !== "oauth" && !reread) return response;
      return send(input, init, true);
    }) as typeof fetch;
  }

  /**
   * A request's headers with its AWS signature, made last, over exactly the
   * method, address, headers and body that are sent.
   */
  private async signed(
    c: Connection,
    auth: { region: string; service?: string },
    url: string,
    init: RequestInit | undefined,
    headers: Record<string, string>,
  ): Promise<Record<string, string>> {
    const get = (field: string) => this.secret(c, field);
    const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all(
      SECRET_FIELDS.sigv4.map(get),
    );
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("An access key ID and its secret are needed.");
    }
    if (init?.body !== undefined && typeof init.body !== "string") {
      throw new Error("Only a text body can be signed.");
    }
    return signRequest(
      url,
      { method: init?.method ?? "GET", headers, body: init?.body },
      { accessKeyId, secretAccessKey, sessionToken },
      { region: auth.region, service: auth.service || "bedrock" },
      new Date((this.env.now ?? Date.now)()),
    );
  }

  private oauthSecrets(connectionId: string): OAuthSecrets {
    const s = this.env.secrets;
    return {
      // A client secret or a signing key may come from a vault; tokens never do.
      get: (field) => {
        const c = this.connections.get(connectionId);
        return c && PAGE_SETTABLE_SECRETS.has(field)
          ? this.secret(c, field)
          : s.get(secretKey(connectionId, field));
      },
      // Tokens and registered clients are bound like a typed secret.
      set: async (field, value) => {
        await this.bind(connectionId);
        await s.set(secretKey(connectionId, field), value);
      },
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
    const get = (field: string) => this.secret(c, field);
    const [cert, key, passphrase, ca, pfx] = await Promise.all(
      ["tlsCert", "tlsKey", "tlsPassphrase", "tlsCa", "tlsPfx"].map(get),
    );
    if (pfx) return mtlsFetch({ pfx: Buffer.from(pfx, "base64"), passphrase, ca });
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
