import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Loopback } from "./oauth";

/**
 * The browser's way back from a sign-in: a listener on 127.0.0.1, on a port
 * the OS picks, open only for the one flow (RFC 8252 §7.3). The literal
 * address rather than `localhost`, as the RFC recommends — a name can be
 * resolved elsewhere, and some systems try IPv6 first.
 *
 * It answers the browser with a page saying the sign-in reached Archyne and
 * the tab can be closed, and answers anything else with a 404, so a stray
 * request (a favicon) cannot end the wait.
 */
export async function nodeLoopback(): Promise<Loopback> {
  let deliver: (url: URL) => void = () => {};
  const arrived = new Promise<URL>((resolve) => (deliver = resolve));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-store",
    });
    res.end(DONE_PAGE);
    deliver(new URL(`${redirectUri}${url.search}`));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  return {
    redirectUri,
    waitForCallback: (signal) =>
      new Promise<URL>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("The sign-in was cancelled."));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("The sign-in timed out.")), {
          once: true,
        });
        void arrived.then(resolve);
      }),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * Shown in the browser after the redirect. Plain and in English on purpose:
 * it is a server's answer rather than part of the app, and it says only what
 * is true without knowing whether the token exchange that follows succeeds.
 */
const DONE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Archyne</title>
<style>body{font:16px system-ui,sans-serif;margin:15vh auto;max-width:28rem;color:#222}</style>
<h1>Back to Archyne</h1>
<p>The sign-in reached Archyne. You can close this tab.</p>`;
