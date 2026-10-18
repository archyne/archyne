/**
 * A `fetch` that presents a client certificate (mutual TLS), for services and
 * token endpoints that authenticate the client by its certificate (RFC 8705).
 *
 * The platform `fetch` has no way to present one — not Node's, not
 * Electron's `net.fetch` from code — so for a connection that asks for mTLS
 * the host makes its requests through `node:https` instead. The price is the
 * one Node always pays: its own root certificates rather than the OS store,
 * so a company CA has to be given explicitly (the `tlsCa` secret). Every
 * other connection keeps the platform fetch.
 *
 * Shaped like `fetch` so everything above it — the chat stream, the OAuth
 * library — needs no second code path. It keeps the host's rules: https
 * only (a certificate over plain http proves nothing), and no redirect is
 * followed, so neither the certificate nor a header goes anywhere unasked.
 */
export interface ClientCertificate {
  /** PEM certificate, with its chain if the server needs one. */
  cert: string;
  /** PEM private key. */
  key: string;
  passphrase?: string;
  /** Extra trusted roots, PEM, added to Node's own — a company CA. */
  ca?: string;
}

export function mtlsFetch(tls: ClientCertificate): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.protocol !== "https:") {
      throw new TypeError("A client certificate is only presented over https.");
    }
    const [{ request }, { rootCertificates }, { Readable }] = await Promise.all([
      import("node:https"),
      import("node:tls"),
      import("node:stream"),
    ]);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: string | Buffer | undefined;
    if (init?.body instanceof URLSearchParams) {
      body = init.body.toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    } else if (typeof init?.body === "string") {
      body = init.body;
    } else if (init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body)) {
      body = Buffer.from(init.body as ArrayBuffer);
    } else if (init?.body != null) {
      throw new TypeError("This request body cannot be sent with a client certificate.");
    }
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          headers,
          cert: tls.cert,
          key: tls.key,
          passphrase: tls.passphrase || undefined,
          ca: tls.ca ? [...rootCertificates, tls.ca] : undefined,
          signal: init?.signal ?? undefined,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            reject(new TypeError("The server redirected, and redirects are not followed."));
            return;
          }
          const out = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
          }
          const empty = method === "HEAD" || status === 204 || status === 304;
          resolve(
            new Response(
              empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
              { status, statusText: res.statusMessage, headers: out },
            ),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }) as typeof fetch;
}
