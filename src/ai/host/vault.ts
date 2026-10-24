/**
 * Secrets kept in a cloud vault instead of on this computer (AUTH.local.md,
 * phase 5). A connection names, for any of its typed secrets, a secret in a
 * vault; the host reads it when a request needs it and keeps it in memory
 * only. The vault itself is described by a connection whose protocol is
 * "vault": its address and sign-in are then kept, bound and signed in to
 * like any other connection's.
 *
 * This file is the part that is the same everywhere: what a vault and a
 * reference look like, which of them are well-formed, and the command each
 * vendor's CLI takes. Every identifier here may have come from a page, and
 * some reach a command line, so each is held to a strict pattern — no
 * spaces, no quotes, nothing a shell would read as its own.
 */
import { credentialTarget, type Connection } from "./connection";

export type VaultKind = "azure-kv" | "aws-sm" | "gcp-sm" | "alibaba-kms" | "hashicorp";

export const VAULT_KINDS: readonly VaultKind[] = [
  "azure-kv",
  "aws-sm",
  "gcp-sm",
  "alibaba-kms",
  "hashicorp",
];

/**
 * Where a vault is and how it is reached. The Key Vault's address and
 * HashiCorp's are the connection's `baseUrl`; the others are named by
 * region or project.
 */
export interface VaultConfig {
  kind: VaultKind;
  /** Through the vendor's CLI, signed in already, or through the connection's own `auth`. */
  via: "cli" | "sign-in";
  /** AWS Secrets Manager, Alibaba KMS. */
  region?: string;
  /** Google Secret Manager. */
  project?: string;
  /** HashiCorp: the KV version 2 mount, `secret` unless set. */
  mount?: string;
  /** HashiCorp Enterprise and OpenBao namespaces. */
  namespace?: string;
  /** The CLI profile to use (aws, aliyun). */
  profile?: string;
}

/** A secret in a vault, standing in for one a person would otherwise type. */
export interface SecretRef {
  /** The id of the vault's connection. */
  vault: string;
  /** The secret's name — for AWS also its ARN, for HashiCorp its path. */
  name: string;
  /**
   * A key inside a secret that holds JSON (as AWS secrets often do), or the
   * field of a HashiCorp KV secret (`value` unless set).
   */
  key?: string;
}

const PATTERNS = {
  azureName: /^[0-9A-Za-z-]{1,127}$/,
  azureVault:
    /^https:\/\/[a-z0-9-]{3,24}\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net)\/?$/,
  awsName: /^[A-Za-z0-9/_+=.@:-]{1,2048}$/,
  awsRegion: /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
  gcpName: /^[A-Za-z0-9_-]{1,255}$/,
  gcpProject: /^([a-z][a-z0-9-]{4,28}[a-z0-9]|\d{1,20})$/,
  alibabaName: /^[A-Za-z0-9_/+=.@:-]{1,192}$/,
  alibabaRegion: /^[a-z]{2}-[a-z0-9-]{2,30}$/,
  hashicorpPath: /^(?!.*\.\.)[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/,
  hashicorpMount: /^[A-Za-z0-9_.-]{1,64}$/,
  namespace: /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/,
  word: /^[A-Za-z0-9_.-]{1,128}$/,
};

/** Why a vault cannot be read as it stands, or null when it can. */
export function vaultProblem(v: Connection): string | null {
  const cfg = v.vault;
  if (v.protocol !== "vault" || !cfg || !VAULT_KINDS.includes(cfg.kind)) return "vault";
  if (cfg.via !== "cli" && cfg.via !== "sign-in") return "vault";
  if (cfg.profile !== undefined && cfg.profile !== "" && !PATTERNS.word.test(cfg.profile)) {
    return "profile";
  }
  switch (cfg.kind) {
    case "azure-kv":
      return PATTERNS.azureVault.test(v.baseUrl) ? null : "address";
    case "aws-sm":
      return PATTERNS.awsRegion.test(cfg.region ?? "") ? null : "region";
    case "gcp-sm":
      return PATTERNS.gcpProject.test(cfg.project ?? "") ? null : "project";
    case "alibaba-kms":
      return PATTERNS.alibabaRegion.test(cfg.region ?? "") ? null : "region";
    case "hashicorp": {
      let url: URL;
      try {
        url = new URL(v.baseUrl);
      } catch {
        return "address";
      }
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
        return "address";
      }
      if (url.username || url.password || url.search || url.hash) return "address";
      if (cfg.mount && !PATTERNS.hashicorpMount.test(cfg.mount)) return "mount";
      if (cfg.namespace && !PATTERNS.namespace.test(cfg.namespace)) return "namespace";
      return null;
    }
  }
}

/** Why a reference cannot name a secret in that vault, or null when it can. */
export function refProblem(v: Connection, ref: SecretRef): string | null {
  if (ref.key !== undefined && ref.key !== "" && !PATTERNS.word.test(ref.key)) return "key";
  const name = ref.name ?? "";
  const ok = {
    "azure-kv": PATTERNS.azureName,
    "aws-sm": PATTERNS.awsName,
    "gcp-sm": PATTERNS.gcpName,
    "alibaba-kms": PATTERNS.alibabaName,
    hashicorp: PATTERNS.hashicorpPath,
  }[v.vault!.kind].test(name);
  return ok ? null : "name";
}

/**
 * The vault as the host tells it apart: where it is, and how it is reached.
 * A change to any of it is a different vault, and an approval given for the
 * old one does not carry over.
 */
export function vaultIdentity(v: Connection): string {
  const cfg = v.vault!;
  return JSON.stringify([
    credentialTarget(v),
    cfg.kind,
    cfg.via,
    cfg.region ?? "",
    cfg.project ?? "",
    cfg.mount ?? "",
    cfg.namespace ?? "",
    cfg.profile ?? "",
  ]);
}

/** A CLI call: the program, its arguments, any environment, and how to read what it prints. */
export interface CliCall {
  program: string;
  args: string[];
  env?: Record<string, string>;
  read(stdout: string): string;
}

/** What a CLI printed, less the newline it ends with. */
const line = (stdout: string) => stdout.replace(/\r?\n$/, "");

/**
 * The command that reads one secret with the vendor's own CLI — the
 * person's sign-in, the person's profile, nothing kept by Archyne.
 * The vault and the reference must have passed `vaultProblem` and
 * `refProblem`.
 */
export function cliCall(v: Connection, ref: SecretRef): CliCall {
  const cfg = v.vault!;
  const profile = cfg.profile ? ["--profile", cfg.profile] : [];
  switch (cfg.kind) {
    case "azure-kv":
      return {
        program: "az",
        args: [
          "keyvault",
          "secret",
          "show",
          "--id",
          `${v.baseUrl.replace(/\/$/, "")}/secrets/${ref.name}`,
          "--query",
          "value",
          "--output",
          "tsv",
        ],
        read: line,
      };
    case "aws-sm":
      return {
        program: "aws",
        args: [
          "secretsmanager",
          "get-secret-value",
          "--secret-id",
          ref.name,
          "--region",
          cfg.region!,
          ...profile,
          "--query",
          "SecretString",
          "--output",
          "text",
        ],
        read: line,
      };
    case "gcp-sm":
      return {
        program: "gcloud",
        args: [
          "secrets",
          "versions",
          "access",
          "latest",
          `--secret=${ref.name}`,
          `--project=${cfg.project}`,
        ],
        read: line,
      };
    case "alibaba-kms":
      return {
        program: "aliyun",
        args: [
          "kms",
          "GetSecretValue",
          "--SecretName",
          ref.name,
          "--region",
          cfg.region!,
          ...profile,
        ],
        read: (stdout) => {
          const data = (JSON.parse(stdout) as { SecretData?: unknown }).SecretData;
          if (typeof data !== "string")
            throw new Error("The vault answered without the secret.");
          return data;
        },
      };
    case "hashicorp":
      return {
        program: "vault",
        args: [
          "kv",
          "get",
          `-mount=${cfg.mount || "secret"}`,
          `-field=${ref.key || "value"}`,
          ref.name,
        ],
        env: {
          VAULT_ADDR: v.baseUrl.replace(/\/$/, ""),
          ...(cfg.namespace ? { VAULT_NAMESPACE: cfg.namespace } : {}),
        },
        read: line,
      };
  }
}

/**
 * The part of a secret that is wanted: the whole of it, or one key of the
 * JSON it holds. HashiCorp picks its field itself.
 */
export function pick(v: Connection, ref: SecretRef, value: string): string {
  if (!ref.key || v.vault!.kind === "hashicorp") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`The secret ${ref.name} is not JSON, so it has no key ${ref.key}.`);
  }
  const picked = (parsed as Record<string, unknown> | null)?.[ref.key];
  if (typeof picked !== "string") {
    throw new Error(`The secret ${ref.name} has no text under ${ref.key}.`);
  }
  return picked;
}
