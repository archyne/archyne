# Generate — edit a diagram by asking

**Generate** (in the overflow menu, **More → Generate**) takes a request in
your own words — "add a retry after the payment fails", "group the databases
in a VPC" — and turns it into an edit of the diagram on screen. Each request
changes what is there now, so a conversation refines one diagram step by
step. The answer is ordinary Mermaid: it lands in the code and on the canvas,
and **Undo** takes it back like any other edit.

Archyne does not ship or host a model. Generate uses one **you** choose:

| Engine             | Where it runs                               | Available in             |
| ------------------ | ------------------------------------------- | ------------------------ |
| **Local server**   | a model server on your own computer         | web, desktop, VS Code    |
| **Remote service** | a hosted model API you have an account with | desktop and VS Code only |

Development builds also carry an experimental engine that runs a small model
inside the browser tab. Release builds leave it out: no model small enough to
download into a browser made edits reliable enough.

## A model on your own computer

Any server that speaks the OpenAI chat-completions API works. The two most
people already have:

| Server                           | Address                     |
| -------------------------------- | --------------------------- |
| [Ollama](https://ollama.com)     | `http://localhost:11434/v1` |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1`  |

Pick one of the presets, press **Check connection**, and choose a model. The
diagram stays on your computer — with one exception the panel points out:
Ollama's _cloud_ models (`…-cloud`) only relay to ollama.com, so a diagram
sent to one leaves the machine.

Model size matters more than anything else here. In testing across all seven
languages the interface speaks, models of around 9B parameters and up (for
example Qwen3.5-9B) edited diagrams reliably; smaller ones often did not.

**In the web version only**, the server must accept requests from the page,
which is a browser rule (CORS) and not something Archyne can relax:

- **Ollama**: set `OLLAMA_ORIGINS` to the address Archyne is served from, and
  restart Ollama.
- **LM Studio**: turn on **Enable CORS** in the server settings.

The panel tells the two cases apart from "nothing is running" and says which
fix applies. The desktop app and the VS Code extension call the server from
their own process, so neither needs this.

The web version reaches **only** `localhost` and `127.0.0.1` — its content
security policy allows nothing else — so a diagram can never be sent from it
to another machine by mistake.

## A hosted service

In the desktop app and in VS Code, **Remote service** connects to a model API
over the network. Choose what kind of service it is, and the panel fills in
the address and the way it signs in:

| Kind                      | Address                                                                                      | Usually signs in with                                  |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| OpenAI-compatible         | the service's base URL, ending in `/v1`                                                      | a key in `Authorization: Bearer`                       |
| Anthropic                 | `https://api.anthropic.com/v1`                                                               | a key in `x-api-key`                                   |
| Azure OpenAI / AI Foundry | `https://<resource>.openai.azure.com/openai/v1` (or `.services.ai.azure.com`)                | a key in `api-key`, or Microsoft Entra through OAuth   |
| Amazon Bedrock            | `https://bedrock-runtime.<region>.amazonaws.com`                                             | an AWS access key (Signature V4), or a Bedrock API key |
| Google Vertex AI          | `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/endpoints/openapi` | a service account key, or a Google sign-in             |

"OpenAI-compatible" covers most gateways and providers that are not listed —
LiteLLM, OpenRouter, vLLM, a company proxy.

For Azure the model field takes your **deployment** name; for Bedrock a model
ID or an inference profile (the list is offered when your key may read it);
for Vertex a name like `google/gemini-…`.

### Ways to sign in

- **A key in a header** — any header name, with or without a prefix.
- **HTTP Basic** — a username and a password.
- **OAuth**, with discovery of the authorization server (OpenID Connect,
  RFC 8414, or from the service itself, RFC 9728):
  - **in the browser** — your system browser opens, you sign in, and it
    returns to Archyne (authorization code with PKCE);
  - **with a device code** — for providers that refuse to return to a local
    address: you type a short code on their page;
  - **as a machine** — client credentials, proven by a secret, a private key
    (`private_key_jwt`) or a client certificate;
  - **as a service account** — an assertion signed with a private key; a
    Google service account's JSON key file can be pasted as it is.

  Tokens are refreshed before they lapse and revoked when you sign out.
  Archyne can register itself with a server that allows it, and can bind its
  tokens to a key kept on your computer (DPoP), so a copied token is useless
  on its own. The implicit and password flows are not offered: OAuth 2.1
  removed them as unsafe.

- **AWS Signature V4** — an access key ID and secret, and a session token for
  temporary credentials.
- **A client certificate** (mutual TLS) — on its own or alongside any of the
  above, with an extra trusted CA for a company's own certificates.

## Where your secrets go

A key, a password, a private key or a token is handed once to the part of
Archyne that runs outside the page — the desktop app's main process, or VS
Code's extension host — and stays there. The form shows **Saved**, never the
value; there is no way to read it back, because the page that renders
diagrams and model output is the last place a credential should be readable.

- **Desktop**: encrypted with the operating system's keychain (Electron
  `safeStorage`). On a Linux system with no keyring the app refuses to save
  secrets rather than keep them in plain text.
- **VS Code**: in VS Code's own secret storage (`SecretStorage`), never in
  `settings.json`.

Removing a service deletes its secrets. The network rules are the same in
both: a remote address must be `https` (plain `http` only to this computer),
and a redirect is never followed, so a credential cannot be bounced to a host
it was not meant for.

**What a service receives** is the diagram's Mermaid text and your request.
Choose a service whose terms you are content to send your diagrams under.
