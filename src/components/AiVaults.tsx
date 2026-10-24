import { useState } from "react";
import { useAiEngine } from "../ai/engine";
import type { Connection } from "../ai/host/connection";
import { VAULT_KINDS, vaultProblem, type VaultConfig, type VaultKind } from "../ai/host/vault";
import { useT, type MessageKey } from "../i18n";

/**
 * The vaults a service's secrets can be read from instead of being kept on
 * this computer (AUTH.local.md, phase 5). Each is read through its vendor's
 * command-line tool, as the person is already signed in to it; nothing about
 * the vault's own sign-in is kept here. Which secret a service takes from
 * which vault is chosen on the service, field by field.
 */

/** Product names, the same in every language. */
const KIND_NAMES: Record<VaultKind, string> = {
  "azure-kv": "Azure Key Vault",
  "aws-sm": "AWS Secrets Manager",
  "gcp-sm": "Google Secret Manager",
  "alibaba-kms": "Alibaba Cloud KMS",
  hashicorp: "HashiCorp Vault / OpenBao",
};

/** The command that reads the secret, and the one that signs in to it. */
const CLI: Record<VaultKind, { command: string; login: string }> = {
  "azure-kv": { command: "az", login: "az login" },
  "aws-sm": { command: "aws", login: "aws sso login" },
  "gcp-sm": { command: "gcloud", login: "gcloud auth login" },
  "alibaba-kms": { command: "aliyun", login: "aliyun configure" },
  hashicorp: { command: "vault", login: "vault login" },
};

const PLACEHOLDER: Partial<Record<VaultKind, string>> = {
  "azure-kv": "https://<name>.vault.azure.net",
  hashicorp: "https://vault.example.com:8200",
};

const PROBLEMS: Record<string, MessageKey> = {
  address: "ai.vaultProblemAddress",
  region: "ai.remoteProblemRegion",
  project: "ai.vaultProblemProject",
  profile: "ai.vaultProblemField",
  mount: "ai.vaultProblemField",
  namespace: "ai.vaultProblemField",
};

export function AiVaults({ disabled }: { disabled: boolean }) {
  const t = useT();
  const vaults = useAiEngine((s) => s.vaults);
  const addVault = useAiEngine((s) => s.addVault);
  const removeVault = useAiEngine((s) => s.removeVault);
  const [picked, setPicked] = useState<string | null>(null);
  const current = vaults.find((v) => v.id === picked) ?? vaults[0] ?? null;

  return (
    <details className="ai-vaults">
      <summary>{t("ai.vaults", { count: vaults.length })}</summary>
      <p className="ai-server-hint">{t("ai.vaultsHint")}</p>
      <div className="ai-server-presets">
        {vaults.length > 0 && (
          <label className="ai-server-field ai-remote-pick">
            {t("ai.vaultPick")}
            <select
              value={current?.id ?? ""}
              aria-label={t("ai.vaultPick")}
              disabled={disabled}
              onChange={(e) => setPicked(e.target.value)}
            >
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label || KIND_NAMES[v.vault?.kind ?? "azure-kv"]}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="editor-action"
          disabled={disabled}
          onClick={() => setPicked(addVault(t("ai.vaultNewName"), "azure-kv"))}
        >
          {t("ai.vaultAdd")}
        </button>
        {current && (
          <button
            type="button"
            className="editor-action"
            disabled={disabled}
            onClick={() => {
              removeVault(current.id);
              setPicked(null);
            }}
          >
            {t("ai.vaultRemove")}
          </button>
        )}
      </div>
      {current && <VaultForm key={current.id} vault={current} disabled={disabled} />}
    </details>
  );
}

function VaultForm({ vault, disabled }: { vault: Connection; disabled: boolean }) {
  const t = useT();
  const updateVault = useAiEngine((s) => s.updateVault);
  const cfg: VaultConfig = vault.vault ?? { kind: "azure-kv", via: "cli" };
  const patch = (p: Partial<Connection>) => updateVault(vault.id, p);
  const set = (p: Partial<VaultConfig>) => patch({ vault: { ...cfg, ...p } });
  // Said once something is typed: an empty form is not yet a mistake.
  const touched =
    vault.baseUrl !== "https://" ||
    [cfg.region, cfg.project, cfg.profile, cfg.mount, cfg.namespace].some(Boolean);
  const problem = touched ? vaultProblem(vault) : null;
  const hasAddress = cfg.kind === "azure-kv" || cfg.kind === "hashicorp";
  const hasRegion = cfg.kind === "aws-sm" || cfg.kind === "alibaba-kms";

  const text = (
    label: MessageKey,
    value: string,
    onChange: (v: string) => void,
    placeholder?: string,
  ) => (
    <label className="ai-server-field">
      {t(label)}
      <input
        type="text"
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </label>
  );

  return (
    <>
      {text("ai.remoteName", vault.label, (label) => patch({ label }))}
      <label className="ai-server-field">
        {t("ai.vaultKind")}
        <select
          value={cfg.kind}
          aria-label={t("ai.vaultKind")}
          disabled={disabled}
          onChange={(e) => set({ kind: e.target.value as VaultKind })}
        >
          {VAULT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_NAMES[kind]}
            </option>
          ))}
        </select>
      </label>
      {hasAddress &&
        text(
          "ai.serverAddress",
          vault.baseUrl === "https://" ? "" : vault.baseUrl,
          (baseUrl) => patch({ baseUrl: baseUrl || "https://" }),
          PLACEHOLDER[cfg.kind],
        )}
      {hasRegion &&
        text(
          "ai.awsRegion",
          cfg.region ?? "",
          (region) => set({ region }),
          cfg.kind === "aws-sm" ? "eu-west-1" : "ap-southeast-1",
        )}
      {cfg.kind === "gcp-sm" &&
        text("ai.vaultProject", cfg.project ?? "", (project) => set({ project }))}
      {cfg.kind === "hashicorp" && (
        <div className="ai-remote-row">
          {text("ai.vaultMount", cfg.mount ?? "", (mount) => set({ mount }), "secret")}
          {text("ai.vaultNamespace", cfg.namespace ?? "", (namespace) => set({ namespace }))}
        </div>
      )}
      {(cfg.kind === "aws-sm" || cfg.kind === "alibaba-kms") &&
        text("ai.vaultProfile", cfg.profile ?? "", (profile) => set({ profile }))}
      <p className="ai-server-hint">{t("ai.vaultCliHint", CLI[cfg.kind])}</p>
      {problem && PROBLEMS[problem] && (
        <p className="ai-server-status" role="status">
          {t(PROBLEMS[problem])}
        </p>
      )}
    </>
  );
}
