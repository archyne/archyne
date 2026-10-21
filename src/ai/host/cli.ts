/**
 * Running a vendor's CLI to read a secret (`vault.ts`, `cliCall`). The
 * command and its arguments are fixed by the host; the identifiers in them
 * have passed `vaultProblem` and `refProblem`, and are checked once more
 * here, because on Windows the CLIs that are `.cmd` shims (az, gcloud) can
 * only be started through a shell.
 */
import { spawn } from "node:child_process";

export interface CliRequest {
  program: string;
  args: string[];
  env?: Record<string, string>;
}

/** Runs a CLI and resolves with what it printed, or rejects with why not. */
export type RunCli = (request: CliRequest) => Promise<string>;

/** Nothing a shell reads as its own: no spaces, quotes, `&`, `|`, `%`, `^`, `<`, `>`, `$`. */
const SAFE = /^[A-Za-z0-9_./:=+@,-]+$/;

const TIMEOUT_MS = 60_000;
const MAX_OUT = 1 << 20;

export const nodeRunCli: RunCli = ({ program, args, env }) =>
  new Promise((resolve, reject) => {
    if (![program, ...args].every((a) => SAFE.test(a))) {
      reject(new Error("Refused to run a command with unexpected characters in it."));
      return;
    }
    const child = spawn(program, args, {
      // The .cmd shims on Windows need cmd.exe; every argument is SAFE.
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${program} did not answer within a minute.`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (out.length < MAX_OUT) out += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (err.length < 8192) err += d;
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          e.code === "ENOENT"
            ? `The ${program} command is not installed, or not on the PATH.`
            : e.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
        return;
      }
      if (code === 9009 || /is not recognized as an internal or external command/i.test(err)) {
        reject(new Error(`The ${program} command is not installed, or not on the PATH.`));
        return;
      }
      // The CLI's own words are the advice: "Please run 'az login'".
      const said = err
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
      reject(new Error(said ? said.slice(0, 400) : `${program} stopped with code ${code}.`));
    });
  });
