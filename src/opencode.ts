import { spawn } from "node:child_process";
import { config } from "./config.ts";

export interface RunOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  agent?: string;
  files?: string[];
  sessionId?: string;
  continueLast?: boolean;
  fork?: boolean;
  auto?: boolean;
  title?: string;
  timeoutMs?: number;
  // when the hard timeout started counting, so it can span several runs (default now)
  startedAt?: number;
  idleMs?: number;
  signal?: AbortSignal;
  bin?: string;
  onProgress?: (p: Progress) => void;
  // called after each step; returning a reason stops the run at that step boundary
  checkStep?: (c: EventCollector) => string | undefined;
}

export interface Progress {
  steps: number;
  toolCalls: number;
  edits: number;
  compactions: number;
  contextTokens: number;
  lastEventAt?: number;
  nudges?: number;
  // how many of the nudges were for stalling, the rest were for compacting
  stallNudges?: number;
}

export interface ToolCall {
  tool: string;
  status: string;
  title?: string;
}

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RunResult {
  ok: boolean;
  sessionId?: string;
  text: string;
  toolCalls: ToolCall[];
  tokens: Tokens;
  cost: number;
  steps: number;
  edits: number;
  compactions: number;
  // resumes forced by the guard
  nudges?: number;
  // how many of the nudges were for stalling, the rest were for compacting
  stallNudges?: number;
  // stopped by checkStep
  stopped?: boolean;
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export function buildArgs(o: RunOptions): string[] {
  const args = ["run", "--format", "json"];
  if (o.model) args.push("--model", o.model);
  if (o.agent) args.push("--agent", o.agent);
  if (o.sessionId) args.push("--session", o.sessionId);
  else if (o.continueLast) args.push("--continue");
  if (o.fork && (o.sessionId || o.continueLast)) args.push("--fork");
  if (o.auto) args.push("--auto");
  if (o.title) args.push("--title", o.title);
  for (const f of o.files ?? []) args.push("--file", f);
  // keeps prompts starting with "-" from parsing as flags
  args.push("--", o.prompt);
  return args;
}

// opencode v2 resolves its directory from $PWD before process.cwd()
export function runEnv(cwd?: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return cwd ? { ...env, PWD: cwd } : env;
}

/** Calls onFire once nothing has kicked it for `ms`. Undefined or 0 means never. */
export function watchdog(ms: number | undefined, onFire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const kick = () => {
    if (!ms) return;
    stop();
    timer = setTimeout(onFire, ms);
  };
  kick();
  return { kick, stop };
}

// a step whose context drops below this share of the previous one was compacted
export const COMPACTION_RATIO = 0.5;
// smaller contexts are never counted as compacted
export const COMPACTION_MIN_CONTEXT = 50_000;
export const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);

export const isCompaction = (prev: number, next: number) => prev >= COMPACTION_MIN_CONTEXT && next < prev * COMPACTION_RATIO;

const secs = (ms: number) => `${Number((ms / 1000).toFixed(1))}s`;

/** Folds `opencode run --format json` event lines into a result. Unknown events are ignored. */
export class EventCollector {
  sessionId?: string;
  toolCalls: ToolCall[] = [];
  tokens: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  cost = 0;
  steps = 0;
  edits = 0;
  compactions = 0;
  // context size of the last step
  contextTokens = 0;
  lastEventAt?: number;
  errors: string[] = [];
  private allTexts: string[] = [];
  private stepTexts: string[] = [];
  private raw: string[] = [];

  /** Returns the event type, if the line was an event. */
  push(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lastEventAt = Date.now();
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      this.raw.push(trimmed);
      return;
    }
    if (e.sessionID && !this.sessionId) this.sessionId = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "step_start":
        this.stepTexts = [];
        break;
      case "text":
        if (typeof p.text === "string") {
          this.allTexts.push(p.text);
          this.stepTexts.push(p.text);
        }
        break;
      case "tool_use":
        this.toolCalls.push({ tool: p.tool, status: p.state?.status, title: p.state?.title });
        if (EDIT_TOOLS.has(p.tool)) this.edits++;
        break;
      case "step_finish": {
        this.steps++;
        const t = p.tokens ?? {};
        this.tokens.input += t.input ?? 0;
        this.tokens.output += t.output ?? 0;
        this.tokens.reasoning += t.reasoning ?? 0;
        this.tokens.cacheRead += t.cache?.read ?? 0;
        this.tokens.cacheWrite += t.cache?.write ?? 0;
        this.cost += Number(p.cost ?? 0) || 0;
        if (p.tokens) {
          const ctx = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
          if (isCompaction(this.contextTokens, ctx)) this.compactions++;
          this.contextTokens = ctx;
        }
        break;
      }
      case "error":
        this.errors.push(errorMessage(e.error ?? e));
        break;
    }
    return e.type;
  }

  get progress(): Progress {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls.length,
      edits: this.edits,
      compactions: this.compactions,
      contextTokens: this.contextTokens,
      lastEventAt: this.lastEventAt,
    };
  }

  /** The final step's text (the answer, minus mid-run narration), else all text, else raw stdout. */
  get text(): string {
    return this.stepTexts.join("\n\n").trim() || this.allTexts.join("\n\n").trim() || this.raw.join("\n").trim();
  }
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

/** e.g. `2 (stall 1, compaction 1)`; kinds only once a stall nudge happened. */
export function formatNudges(nudges: number, stallNudges = 0): string {
  if (!stallNudges) return String(nudges);
  return `${nudges} (stall ${stallNudges}, compaction ${nudges - stallNudges})`;
}

/** One line for a running task, e.g. `steps 94  tools 100  edits 0  compactions 2  ctx 20k  last activity 12s ago`. */
export function formatProgress(p: Progress, now = Date.now()): string {
  const parts = [`steps ${p.steps}`, `tools ${p.toolCalls}`, `edits ${p.edits}`, `compactions ${p.compactions}`, `ctx ${kTokens(p.contextTokens)}`];
  if (p.nudges) parts.push(`nudges ${formatNudges(p.nudges, p.stallNudges)}`);
  if (p.lastEventAt) parts.push(`last activity ${Math.max(0, Math.round((now - p.lastEventAt) / 1000))}s ago`);
  return parts.join("  ");
}

function errorMessage(err: any): string {
  const msg = err?.data?.message ?? err?.message ?? err?.name ?? err?.type;
  const ref = err?.data?.ref ? ` (ref ${err.data.ref})` : "";
  return typeof msg === "string" ? msg + ref : JSON.stringify(err);
}

export function runOpencode(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const collector = new EventCollector();
  return new Promise((resolve) => {
    const bin = o.bin ?? config.bin;
    const child = spawn(bin, buildArgs(o), { cwd: o.cwd, env: runEnv(o.cwd), stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let timedOut = false;
    let stalled = false;
    let settled = false;
    let stopReason: string | undefined;

    const kill = () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    };
    // hard cap (off by default) and stall detection: only a run that goes quiet is stuck
    const capMs = o.timeoutMs && Math.max(1, o.timeoutMs - (started - (o.startedAt ?? started)));
    const deadline = watchdog(capMs, () => {
      timedOut = true;
      kill();
    });
    const idle = watchdog(o.idleMs, () => {
      timedOut = stalled = true;
      kill();
    });
    if (o.signal?.aborted) kill();
    else o.signal?.addEventListener("abort", kill, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      idle.kick();
      buf += chunk;
      let i: number;
      // nothing after a stop counts
      while (!stopReason && (i = buf.indexOf("\n")) >= 0) {
        const type = collector.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        o.onProgress?.(collector.progress);
        if (type !== "step_finish") continue;
        stopReason = o.checkStep?.(collector);
        if (stopReason) kill();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      deadline.stop();
      idle.stop();
      if (!stopReason) collector.push(buf);
      const errors = [...collector.errors];
      if (spawnError) errors.push(spawnError);
      if (stopReason) errors.push(stopReason);
      else if (stalled) errors.push(`stalled: no output for ${secs(o.idleMs ?? 0)}`);
      else if (timedOut) errors.push(`timed out after ${secs(o.timeoutMs ?? 0)}`);
      else if (o.signal?.aborted) errors.push("cancelled");
      if (exitCode && !errors.length) errors.push(stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${exitCode}`);
      resolve({
        ok: exitCode === 0 && !errors.length,
        sessionId: collector.sessionId,
        text: collector.text,
        toolCalls: collector.toolCalls,
        tokens: collector.tokens,
        cost: collector.cost,
        steps: collector.steps,
        edits: collector.edits,
        compactions: collector.compactions,
        stopped: !!stopReason,
        error: errors.join("; ") || undefined,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(null, `failed to start '${bin}': ${err.message}`));
    child.on("close", (code) => finish(code));
  });
}

export function execText(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.bin, args, { cwd, env: runEnv(cwd), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
