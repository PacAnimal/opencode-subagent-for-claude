import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// gui hosts often don't inherit the shell PATH
const FALLBACK_DIRS = [
  join(homedir(), ".opencode", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".local", "bin"),
  join(homedir(), ".npm-global", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

export function resolveBin(env = process.env): string {
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, "opencode");
    if (existsSync(candidate)) return candidate;
  }
  return "opencode";
}

// empty or unset means opencode's own default model
const model = (v: string | undefined) => v?.trim() || undefined;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return !/^(0|false|no|off)$/i.test(v);
}

function int(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const env = process.env;
const defaultModel = model(env.OPENCODE_DELEGATE_DEFAULT_MODEL);

export const config = {
  bin: resolveBin(),
  defaultModel,
  // used for read-only runs (auto: false) when no model is given
  readModel: model(env.OPENCODE_DELEGATE_READ_MODEL) ?? defaultModel,
  auto: bool(env.OPENCODE_DELEGATE_AUTO, true),
  timeoutSec: int(env.OPENCODE_DELEGATE_TIMEOUT, 1800),
  maxOutputChars: int(env.OPENCODE_DELEGATE_MAX_OUTPUT, 40000),
  defaultCwd: env.OPENCODE_DELEGATE_CWD || env.CLAUDE_PROJECT_DIR || process.cwd(),
  // highest priority first
  preferredProviders: (env.OPENCODE_DELEGATE_PREFERRED_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean),
};
