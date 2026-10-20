import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { config } from "./config.ts";
import { resolveModelOrThrow } from "./models.ts";
import { formatNudges, runOpencode, type EventCollector, type Progress, type RunOptions, type RunResult } from "./opencode.ts";

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

// the report format every run ends with
export const REPORT_FORMAT = `- End your reply with these two sections, in this order:
## Needs
Exactly what you need from your lead and why: a tool to install, a config change, a decision, access. Also list anything your code relies on that isn't already in the project (a package not in the manifest, an env var, a config entry), even if you finished. Write "none" only if there is nothing.
## Result
A short summary: files changed, and anything left undone.`;

// the report format every read-only run ends with
export const READ_REPORT_FORMAT = `- End your reply with these two sections, in this order:
## Needs
Anything you could not check without help from your lead (a tool, access, a decision), and why. Write "none" only if there is nothing.
## Result
Your answer: what you were asked for, e.g. the verdict and each finding with file:line.`;

// appended to every read-only brief (auto: false): reviews, questions, research
export const READ_RULES = `---
Rules for this task (from your lead):
- You are reading, not implementing. Change nothing: no edits, no commits, no installs, no commands that change files, git or the environment.
How to work:
- Be quick. Every step you take is slow and costly, so take few of them.
- Read each file you need whole, in one read, rather than in slices; most source files are small. Don't re-read what you have already read.
- Put independent reads and searches in the same step, as parallel tool calls.
- Answer as soon as you can. Don't keep checking a conclusion you have already reached.
${READ_REPORT_FORMAT}`;

// appended to every editing brief; the lead (Claude) verifies and handles anything environmental
export const GRUNT_RULES = `---
Rules for this task (from your lead):
- You are an implementer. Do only the implementation work described above, within the files it gives you. Nothing more.
- Never commit. Leave all changes uncommitted for your lead.
- Do not run tests, linters, formatters, type checks or builds. Your lead verifies.
- Do not install, upgrade or remove anything: no packages, dependencies, tools or SDKs.
- Do not change project or tool config (package manifests, lock files, build, CI, lint or editor config, env files) unless the task explicitly assigns that file to you.
- Do not run any other git command that changes state (push, branch, checkout, stash, reset).
- If you need any of the above, hit a missing tool or permission, or the task is unclear, don't work around it. Do what you can without it, then stop.
How to work:
- Work in increments: read only what you need for the next change, make it, then move on. Don't survey everything first.
- Your context is limited and gets compacted when it fills. After a compaction, continue from your summary's next step and re-read only the file you are about to edit.
- Change files with the edit/write tools, not shell redirection.
${REPORT_FORMAT}`;

// sent when the loop guard resumes a session that keeps compacting without changing anything
export const NUDGE = `Your context has been compacted {n} times without you changing any file. Stop exploring. Using your summary, make the next change now: open only the file you are about to edit, edit it, then continue with the next one.`;

// sent when the stall guard resumes a session that keeps reading and thinking without changing anything
export const STALL_NUDGE = `You have spent {n} steps without changing any file. You have investigated enough: write the first file of the change now, then continue file by file, keeping each step small. If you are blocked, stop and say why under ## Needs.`;

// sent when the read budget runs out on a read-only run
export const WRAP_UP = `You have spent {n} steps reading. Stop investigating and write your answer now from what you have. Mark anything you could not confirm as unconfirmed rather than reading further.`;

export const nudgePrompt = (n: number) => `${NUDGE.replace("{n}", String(n))}\n\n${REPORT_FORMAT}`;

export const stallPrompt = (n: number) => `${STALL_NUDGE.replace("{n}", String(n))}\n\n${REPORT_FORMAT}`;

export const wrapUpPrompt = (n: number) => `${WRAP_UP.replace("{n}", String(n))}\n\n${READ_REPORT_FORMAT}`;

export const withRules = (prompt: string, auto: boolean) => `${prompt}\n\n${auto ? GRUNT_RULES : READ_RULES}`;

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

export function gitStatus(cwd: string): Set<string> | undefined {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return new Set(r.stdout.split("\n").filter(Boolean));
}

export function pickModel(input: Pick<DelegateInput, "model" | "auto">, cfg = config): string | undefined {
  if (input.model) return input.model;
  return (input.auto ?? cfg.auto) ? cfg.defaultModel : cfg.readModel;
}

export interface GuardConfig {
  // compactions without progress that count as looping; 0 disables the trigger
  loopCompactions: number;
  // steps without progress that count as stalled; 0 disables the trigger
  stallSteps: number;
  // steps a read-only run may take before it is told to answer; 0 disables the trigger
  readSteps: number;
  // one budget across both triggers
  maxNudges: number;
}

// steps between git status checks while counting toward a stall
export const STALL_STATUS_EVERY = 5;

const statusKey = (cwd: string) => [...(gitStatus(cwd) ?? [])].sort().join("\n");

/**
 * checkStep for runOpencode: stops a run once it compacts `limit` times, or runs `stallSteps` steps,
 * without editing or changing git status.
 */
export function loopGuard(limit: number, cwd: string, stallSteps = 0): (c: EventCollector) => string | undefined {
  let since = 0;
  let idle = 0;
  let seenEdits = 0;
  let seenCompactions = 0;
  let status = limit || stallSteps ? statusKey(cwd) : "";
  const progressed = () => {
    since = 0;
    idle = 0;
  };
  const checkStatus = () => {
    const now = statusKey(cwd);
    if (now !== status) progressed();
    status = now;
  };
  return (c) => {
    if (!limit && !stallSteps) return;
    idle++;
    if (c.edits > seenEdits) progressed();
    seenEdits = c.edits;
    if (limit && c.compactions !== seenCompactions) {
      seenCompactions = c.compactions;
      checkStatus();
      since++;
      if (since >= limit) return `looping: compacted ${since} times without changing any file`;
    }
    if (!stallSteps) return;
    if (idle % STALL_STATUS_EVERY === 0 || idle >= stallSteps) checkStatus();
    return idle >= stallSteps ? `stalled: ${idle} steps without changing any file` : undefined;
  };
}

// the nudge for a run the guard stopped, by the reason it gave
function nudgeFor(error: string | undefined, guard: GuardConfig, readOnly: boolean): { prompt: string; stall: boolean } {
  const stalled = error?.match(/stalled: (\d+) steps/);
  if (stalled) return { prompt: readOnly ? wrapUpPrompt(Number(stalled[1])) : stallPrompt(Number(stalled[1])), stall: true };
  const n = Number(error?.match(/compacted (\d+) times/)?.[1] ?? guard.loopCompactions);
  return { prompt: nudgePrompt(n), stall: false };
}

function merge(runs: RunResult[], startedAt: number): RunResult {
  const last = runs[runs.length - 1]!;
  const sum = (f: (r: RunResult) => number) => runs.reduce((n, r) => n + f(r), 0);
  return {
    ...last,
    sessionId: last.sessionId ?? runs.find((r) => r.sessionId)?.sessionId,
    toolCalls: runs.flatMap((r) => r.toolCalls),
    tokens: {
      input: sum((r) => r.tokens.input),
      output: sum((r) => r.tokens.output),
      reasoning: sum((r) => r.tokens.reasoning),
      cacheRead: sum((r) => r.tokens.cacheRead),
      cacheWrite: sum((r) => r.tokens.cacheWrite),
    },
    cost: sum((r) => r.cost),
    steps: sum((r) => r.steps),
    edits: sum((r) => r.edits),
    compactions: sum((r) => r.compactions),
    nudges: runs.length - 1,
    durationMs: Date.now() - startedAt,
  };
}

/** Runs opencode, resuming the same session with a nudge when the guard stops it. */
export async function runGuarded(o: RunOptions, guard: GuardConfig, cwd = o.cwd ?? process.cwd()): Promise<RunResult> {
  const startedAt = o.startedAt ?? Date.now();
  const runs: RunResult[] = [];
  const base = { steps: 0, toolCalls: 0, edits: 0, compactions: 0 };
  // read-only runs legitimately never edit, so every step counts toward their budget
  const readOnly = !o.auto;
  const stallSteps = readOnly ? guard.readSteps : guard.stallSteps;
  let stallNudges = 0;
  let opts: RunOptions = o;
  for (;;) {
    const nudges = runs.length;
    const stalls = stallNudges;
    const onProgress = (p: Progress) =>
      o.onProgress?.({
        ...p,
        steps: base.steps + p.steps,
        toolCalls: base.toolCalls + p.toolCalls,
        edits: base.edits + p.edits,
        compactions: base.compactions + p.compactions,
        nudges,
        stallNudges: stalls,
      });
    const checkStep = loopGuard(guard.loopCompactions, cwd, stallSteps);
    const r = await runOpencode({ ...opts, startedAt, onProgress, checkStep });
    runs.push(r);
    base.steps += r.steps;
    base.toolCalls += r.toolCalls.length;
    base.edits += r.edits;
    base.compactions += r.compactions;
    const sessionId = r.sessionId ?? opts.sessionId;
    if (!r.stopped || runs.length > guard.maxNudges || !sessionId || o.signal?.aborted) break;
    const nudge = nudgeFor(r.error, guard, readOnly);
    if (nudge.stall) stallNudges++;
    opts = { ...o, prompt: nudge.prompt, sessionId, continueLast: false, fork: false, files: undefined, title: undefined };
  }
  const result = { ...merge(runs, startedAt), stallNudges };
  if (readOnly) result.error = result.error?.replace(/stalled: (\d+) steps without changing any file/, "over budget: $1 steps reading");
  if (o.signal?.aborted && result.stopped) result.error = [result.error, "cancelled"].filter(Boolean).join("; ");
  return result;
}

export interface DelegateOptions {
  onProgress?: (p: Progress) => void;
  guard?: GuardConfig;
}

export async function delegate(input: DelegateInput, signal?: AbortSignal, opts: DelegateOptions = {}): Promise<DelegateOutcome> {
  const cwd = resolve(config.defaultCwd, input.cwd ?? ".");
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const auto = input.auto ?? config.auto;
  const query = pickModel(input);
  const model = query ? await resolveModelOrThrow(query) : undefined;
  const files = input.files?.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));

  const before = gitStatus(cwd);
  const head = gitHead(cwd);
  const guard = opts.guard ?? { loopCompactions: config.loopCompactions, stallSteps: config.stallSteps, readSteps: config.readSteps, maxNudges: config.maxNudges };
  const result = await runGuarded(
    {
      prompt: withRules(input.prompt, auto),
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
      onProgress: opts.onProgress,
    },
    guard,
    cwd,
  );
  const after = before && gitStatus(cwd);
  const changedFiles = after ? [...after].filter((l) => !before!.has(l)) : undefined;
  const newCommits = head ? commitsSince(cwd, head) : undefined;
  return { model, cwd, result, changedFiles, newCommits };
}

// why the run was resumed, e.g. `2 (stall 1, compaction 1)`
function nudgeSummary(nudges: number, stallNudges = 0): string {
  if (!stallNudges) return `${nudges} (resumed after compacting without changes)`;
  if (stallNudges === nudges) return `${nudges} (resumed after steps without changes)`;
  return formatNudges(nudges, stallNudges);
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
    `edits: ${r.edits ?? 0}, compactions: ${r.compactions ?? 0}${r.nudges ? `, nudges: ${nudgeSummary(r.nudges, r.stallNudges)}` : ""}`,
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
