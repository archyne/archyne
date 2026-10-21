import { describe, expect, it } from "vitest";
import type { Connection } from "./connection";
import { AiHost, secretKey, type HostEvent, type SecretStore } from "./core";
import type { CliRequest } from "./cli";
import { cliCall, pick, refProblem, vaultProblem, type SecretRef } from "./vault";
import { askText, type VaultAsk } from "./vaultAsk";

/**
 * Secrets read from a cloud vault (AUTH.local.md, phase 5): which vaults and
 * names are accepted — each may have come from a page, and may reach a
 * command line — the command each vendor's CLI is given, and what the host
 * does with the answer: ask the person first, keep it in memory only, read
 * it again when the service refuses it.
 */

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

const vault = (
  kind: NonNullable<Connection["vault"]>["kind"],
  extra: Partial<Connection> = {},
) =>
  ({
    id: "kv",
    label: "Production vault",
    baseUrl:
      kind === "azure-kv" ? "https://kv-prod.vault.azure.net" : "https://vault.acme.example",
    protocol: "vault",
    auth: { type: "none" },
    vault: { kind, via: "cli", region: "eu-west-1", project: "acme-ai", ...extra.vault },
    ...extra,
  }) as Connection;

describe("which vaults and names are accepted", () => {
  it("takes each kind of vault as its vendor names it", () => {
    expect(vaultProblem(vault("azure-kv"))).toBeNull();
    expect(vaultProblem(vault("aws-sm"))).toBeNull();
    expect(vaultProblem(vault("gcp-sm"))).toBeNull();
    expect(
      vaultProblem(
        vault("alibaba-kms", {
          vault: { kind: "alibaba-kms", via: "cli", region: "ap-southeast-1" },
        }),
      ),
    ).toBeNull();
    expect(
      vaultProblem(
        vault("hashicorp", {
          vault: { kind: "hashicorp", via: "cli", mount: "kv", namespace: "team/ai" },
        }),
      ),
    ).toBeNull();
    expect(
      refProblem(vault("aws-sm"), {
        vault: "kv",
        name: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:openai-AbC123",
        key: "api_key",
      }),
    ).toBeNull();
    expect(
      refProblem(vault("hashicorp"), { vault: "kv", name: "ai/openai", key: "key" }),
    ).toBeNull();
  });

  it("refuses an address that is not a Key Vault, or a region that is not one", () => {
    expect(vaultProblem({ ...vault("azure-kv"), baseUrl: "https://collector.example" })).toBe(
      "address",
    );
    expect(
      vaultProblem({ ...vault("azure-kv"), baseUrl: "http://kv-prod.vault.azure.net" }),
    ).toBe("address");
    expect(
      vaultProblem(
        vault("aws-sm", { vault: { kind: "aws-sm", via: "cli", region: "eu-west-1 --debug" } }),
      ),
    ).toBe("region");
    expect(vaultProblem({ ...vault("hashicorp"), baseUrl: "http://vault.acme.example" })).toBe(
      "address",
    );
    expect(
      vaultProblem(
        vault("aws-sm", {
          vault: { kind: "aws-sm", via: "cli", region: "eu-west-1", profile: "a&b" },
        }),
      ),
    ).toBe("profile");
  });

  it("refuses any name a shell could read as more than a name", () => {
    const kv = vault("azure-kv");
    for (const name of [
      'key" & calc',
      "key;rm",
      "key|x",
      "$(x)",
      "key name",
      "%PATH%",
      "a^b",
      "",
    ]) {
      expect(refProblem(kv, { vault: "kv", name })).toBe("name");
    }
    expect(refProblem(vault("hashicorp"), { vault: "kv", name: "ai/../root" })).toBe("name");
    expect(refProblem(kv, { vault: "kv", name: "openai-key", key: "a b" })).toBe("key");
  });
});

describe("the command each CLI is given", () => {
  const ref: SecretRef = { vault: "kv", name: "openai-key" };

  it("asks az for the Key Vault secret's value alone", () => {
    const call = cliCall(vault("azure-kv"), ref);
    expect([call.program, ...call.args]).toEqual([
      "az",
      "keyvault",
      "secret",
      "show",
      "--id",
      "https://kv-prod.vault.azure.net/secrets/openai-key",
      "--query",
      "value",
      "--output",
      "tsv",
    ]);
    expect(call.read("sk-azure\r\n")).toBe("sk-azure");
  });

  it("names the region and profile to aws, and the project to gcloud", () => {
    const aws = cliCall(
      vault("aws-sm", {
        vault: { kind: "aws-sm", via: "cli", region: "eu-west-1", profile: "ai" },
      }),
      ref,
    );
    expect(aws.args).toEqual([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      "openai-key",
      "--region",
      "eu-west-1",
      "--profile",
      "ai",
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);
    const gcp = cliCall(vault("gcp-sm"), ref);
    expect([gcp.program, ...gcp.args]).toEqual([
      "gcloud",
      "secrets",
      "versions",
      "access",
      "latest",
      "--secret=openai-key",
      "--project=acme-ai",
    ]);
  });

  it("reads SecretData out of aliyun's JSON, and points vault at its server", () => {
    const ali = cliCall(
      vault("alibaba-kms", {
        vault: { kind: "alibaba-kms", via: "cli", region: "cn-hangzhou" },
      }),
      ref,
    );
    expect(ali.read(JSON.stringify({ SecretData: "sk-qwen", SecretDataType: "text" }))).toBe(
      "sk-qwen",
    );
    const hc = cliCall(
      vault("hashicorp", {
        vault: { kind: "hashicorp", via: "cli", mount: "kv", namespace: "team" },
      }),
      { vault: "kv", name: "ai/openai", key: "token" },
    );
    expect(hc.args).toEqual(["kv", "get", "-mount=kv", "-field=token", "ai/openai"]);
    expect(hc.env).toEqual({
      VAULT_ADDR: "https://vault.acme.example",
      VAULT_NAMESPACE: "team",
    });
  });

  it("takes one key out of a secret that holds JSON", () => {
    const aws = vault("aws-sm");
    expect(
      pick(aws, { vault: "kv", name: "s", key: "api_key" }, '{"api_key":"sk-1","org":"o"}'),
    ).toBe("sk-1");
    expect(() => pick(aws, { vault: "kv", name: "s", key: "api_key" }, "plain")).toThrow(
      /not JSON/,
    );
  });
});

describe("the question the host asks", () => {
  it("names the secret, the vault, the address and the field, in the app's language", () => {
    const ask: VaultAsk = {
      secret: "openai-key",
      vault: "Production vault",
      destination: "https://acme.openai.azure.com",
      field: "key",
    };
    expect(askText("en-US", ask).detail).toBe(
      "Archyne will read “openai-key” from the vault “Production vault” and send it to https://acme.openai.azure.com as the API key. You are asked once; pointing the service elsewhere asks again.",
    );
    for (const locale of ["it", "de", "es", "ja", "zh", "ar"]) {
      const text = askText(locale, ask);
      expect(text.detail).toContain("openai-key");
      expect(text.detail).toContain("https://acme.openai.azure.com");
      expect(text.detail).not.toMatch(/\{\w+\}/);
      expect(text.allow).not.toBe(askText("en", ask).allow);
    }
    expect(askText("pt-BR", ask).allow).toBe("Allow");
  });
});

describe("a connection whose key is in a vault", () => {
  const SERVICE: Connection = {
    id: "gw",
    label: "Gateway",
    baseUrl: "https://gateway.example.com/v1",
    protocol: "openai",
    auth: { type: "header", name: "api-key" },
    fromVault: { key: { vault: "kv", name: "openai-key" } },
  };
  const KV = vault("azure-kv");

  function setup(options: { keys?: string[]; allow?: boolean; cliError?: string } = {}) {
    const keys = [...(options.keys ?? ["sk-from-vault"])];
    const secrets = memorySecrets();
    const asked: VaultAsk[] = [];
    const ran: CliRequest[] = [];
    const sent: string[] = [];
    let current = keys.shift()!;
    const host = new AiHost({
      secrets,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = (init?.headers as Record<string, string>)["api-key"];
        sent.push(key);
        if (key !== "sk-current") {
          if (String(input).endsWith("/models") && key === current) {
            return Response.json({ data: [{ id: "m" }] });
          }
          if (key !== current) return new Response("", { status: 401 });
        }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "graph TD" } }] })}\n\ndata: [DONE]\n\n`,
        );
      }) as typeof fetch,
      runCli: async (request) => {
        ran.push(request);
        if (options.cliError) throw new Error(options.cliError);
        return `${current}\n`;
      },
      confirm: async (_text, ask) => {
        asked.push(ask);
        return options.allow ?? true;
      },
    });
    const rotate = () => {
      current = keys.shift()!;
    };
    return { host, secrets, asked, ran, sent, rotate };
  }

  const turn = async (host: AiHost) => {
    const events: HostEvent[] = [];
    await host.chat("r", "gw", "m", [{ role: "user", content: "draw" }], (e) => events.push(e));
    return events.at(-1)!;
  };

  it("asks once where it goes, reads it with the CLI, and never stores it", async () => {
    const { host, secrets, asked, ran, sent } = setup();
    await host.setConnections([SERVICE, KV]);
    expect(await turn(host)).toMatchObject({ type: "ai:done" });
    expect(await turn(host)).toMatchObject({ type: "ai:done" });
    expect(asked).toEqual([
      {
        secret: "openai-key",
        vault: "Production vault",
        destination: "https://gateway.example.com",
        field: "key",
      },
    ]);
    expect(ran).toHaveLength(1);
    expect(sent.every((k) => k === "sk-from-vault")).toBe(true);
    expect([...secrets.data.values()].join()).not.toContain("sk-from-vault");
  });

  it("reads it again when the service refuses it — a key rotated in the vault", async () => {
    const { host, ran, sent, rotate } = setup({ keys: ["sk-old", "sk-new"] });
    await host.setConnections([SERVICE, KV]);
    expect(await turn(host)).toMatchObject({ type: "ai:done" });
    rotate();
    expect(await turn(host)).toMatchObject({ type: "ai:done" });
    expect(ran).toHaveLength(2);
    expect(sent.slice(-2)).toEqual(["sk-old", "sk-new"]);
  });

  it("sends nothing when the person does not allow it, and says why", async () => {
    const { host, sent } = setup({ allow: false });
    await host.setConnections([SERVICE, KV]);
    expect(await turn(host)).toMatchObject({
      type: "ai:error",
      reason: "vault",
      detail: "Sending that secret from the vault was not allowed.",
    });
    expect(sent).toEqual([]);
  });

  it("asks again when the connection points elsewhere, or the vault is another", async () => {
    const { host, asked } = setup();
    await host.setConnections([SERVICE, KV]);
    await turn(host);
    await host.setConnections([{ ...SERVICE, baseUrl: "https://collector.example/v1" }, KV]);
    await turn(host);
    await host.setConnections([
      { ...SERVICE, baseUrl: "https://collector.example/v1" },
      { ...KV, baseUrl: "https://kv-other.vault.azure.net" },
    ]);
    await turn(host);
    expect(asked.map((a) => a.destination)).toEqual([
      "https://gateway.example.com",
      "https://collector.example",
      "https://collector.example",
    ]);
  });

  it("reports what the CLI said when it cannot read the secret", async () => {
    const { host } = setup({ cliError: "Please run 'az login' to setup account." });
    await host.setConnections([SERVICE, KV]);
    expect(await host.probe("gw")).toEqual({
      state: "vault",
      detail: "Please run 'az login' to setup account.",
    });
    expect(await turn(host)).toMatchObject({ reason: "vault" });
  });

  it("will not send one without a way to ask", async () => {
    const host = new AiHost({
      secrets: memorySecrets(),
      fetch: (async () => new Response("")) as unknown as typeof fetch,
      runCli: async () => "sk",
    });
    await host.setConnections([SERVICE, KV]);
    expect(await host.probe("gw")).toMatchObject({ state: "vault" });
  });

  it("forgets what it allowed when the connection is removed", async () => {
    const { host, secrets } = setup();
    await host.setConnections([SERVICE, KV]);
    await turn(host);
    expect(secrets.data.has(secretKey("gw", "approvals"))).toBe(true);
    await host.setConnections([KV]);
    expect(secrets.data.size).toBe(0);
  });
});
