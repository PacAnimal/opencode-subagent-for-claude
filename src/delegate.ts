import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { config } from "./config.ts";
import { resolveModelOrThrow } from "./models.ts";
import { runOpencode, type RunResult } from "./opencode.ts";

export interface DelegateInput {
  prompt: string;
  model?: string;
  cwd?: string;
  agent?: string;
  files?: string[];
  session_id?: string;
  continue?: boolean;
  fork?: boolean;
  auto?: boolean;
  title?: string;
  timeout_s?: number;
}

export interface DelegateOutcome {
  model?: string;
  cwd: string;
  result: RunResult;
  changedFiles?: string[];
  newCommits?: string[];
}

// appended to every brief; the lead (Claude) verifies and handles anything environmental
export const GRUNT_RULES = `---
Rules for this task (from your lead):
- You are an implementer. Do only the implementation work described above, within the files it gives you. Nothing more.
- Never commit. Leave all changes uncommitted for your lead.
- Do not run tests, linters, formatters, type checks or builds. Your lead verifies.
- Do not install, upgrade or remove anything: no packages, dependencies, tools or SDKs.
- Do not change project or tool config (package manifests, lock files, build, CI, lint or editor config, env files) unless the task explicitly assigns that file to you.
- Do not run any other git command that changes state (push, branch, checkout, stash, reset).
- If you need any of the above, hit a missing tool or permission, or the task is unclear, don't work around it. Do what you can without it, then stop.
- End your reply with these two sections, in this order:
## Needs
Exactly what you need from your lead and why: a tool to install, a config change, a decision, access. Also list anything your code relies on that isn't already in the project (a package not in the manifest, an env var, a config entry), even if you finished. Write "none" only if there is nothing.
## Result
A short summary: files changed, and anything left undone.`;

export const withGruntRules = (prompt: string) => `${prompt}\n\n${GRUNT_RULES}`;

export function extractNeeds(text: string): string | undefined {
  const m = text.match(/^## Needs[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  const needs = m?.[1]?.trim();
  return needs && !/^none\.?$/i.test(needs) ? needs : undefined;
}

function gitHead(cwd: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function commitsSince(cwd: string, head: string): string[] {
  const r = spawnSync("git", ["log", "--oneline", `${head}..HEAD`], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function gitStatus(cwd: string): Set<string> | undefined {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return new Set(r.stdout.split("\n").filter(Boolean));
}

export function pickModel(input: Pick<DelegateInput, "model" | "auto">, cfg = config): string | undefined {
  if (input.model) return input.model;
  return (input.auto ?? cfg.auto) ? cfg.defaultModel : cfg.readModel;
}

export async function delegate(input: DelegateInput, signal?: AbortSignal): Promise<DelegateOutcome> {
  const cwd = resolve(config.defaultCwd, input.cwd ?? ".");
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const auto = input.auto ?? config.auto;
  const query = pickModel(input);
  const model = query ? await resolveModelOrThrow(query) : undefined;
  const files = input.files?.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));

  const before = gitStatus(cwd);
  const head = gitHead(cwd);
  const result = await runOpencode({
    prompt: withGruntRules(input.prompt),
    model,
    cwd,
    agent: input.agent,
    files,
    sessionId: input.session_id,
    continueLast: input.continue,
    fork: input.fork,
    auto,
    title: input.title,
    timeoutMs: (input.timeout_s ?? config.timeoutSec) * 1000,
    idleMs: config.idleSec * 1000,
    signal,
  });
  const after = before && gitStatus(cwd);
  const changedFiles = after ? [...after].filter((l) => !before!.has(l)) : undefined;
  const newCommits = head ? commitsSince(cwd, head) : undefined;
  return { model, cwd, result, changedFiles, newCommits };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars, continue the session to ask for the rest]`;
}

export function formatOutcome(o: DelegateOutcome, maxChars = config.maxOutputChars): string {
  const r = o.result;
  const t = r.tokens;
  const lines = [
    `status: ${r.ok ? "ok" : "error"}`,
    `model: ${o.model ?? "(opencode default)"}`,
    `session_id: ${r.sessionId ?? "(none)"}`,
    `cwd: ${o.cwd}`,
    `duration: ${(r.durationMs / 1000).toFixed(1)}s, steps: ${r.steps}, tokens in/out: ${t.input + t.cacheRead}/${t.output}${r.cost ? `, cost: $${r.cost.toFixed(4)}` : ""}`,
  ];
  if (r.error) lines.push(`error: ${r.error}`);
  const needs = extractNeeds(r.text);
  if (needs) lines.push(`NEEDS (handle these yourself or ask the user, then continue the session):\n${needs}`);
  if (r.toolCalls.length) {
    const counts = new Map<string, number>();
    for (const c of r.toolCalls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
    lines.push(`tools used: ${[...counts].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  if (o.newCommits?.length) lines.push(`RULE BROKEN: opencode committed (undo or keep it yourself):\n${o.newCommits.map((c) => `  ${c}`).join("\n")}`);
  if (o.changedFiles) {
    lines.push(o.changedFiles.length ? `git changes:\n${o.changedFiles.map((f) => `  ${f}`).join("\n")}` : "git changes: none");
  }
  lines.push("", "--- response ---", truncate(r.text || "(no text output)", maxChars));
  return lines.join("\n");
}
