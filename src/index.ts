#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.ts";
import { delegate, formatOutcome } from "./delegate.ts";
import { listModels } from "./models.ts";
import { execText, formatProgress, type Progress } from "./opencode.ts";
import { getTask, listTasks, startTask, waitTask, type Task } from "./tasks.ts";
import pkg from "../package.json" with { type: "json" };

// shown to the host model in its system prompt
const INSTRUCTIONS = `Opt-in only. Never use these tools unless the user has asked you to use opencode.
Once they have, it is mandatory: opencode is your team of junior devs for implementation grunt work. Split the work into scoped tasks and launch many in parallel with delegate_async (separate worktrees or non-overlapping files).
Grunts do grunt work, nothing more. Rules appended to every brief stop them from verifying, committing, installing anything, or touching config, git or the environment. You run the tests, lint and build yourself, review the diff, then send every failure or review finding back as a new implementation task (same session_id). Repeat until your verification passes.
When a result has a NEEDS block (a tool, dependency, config change, access or decision), handle it yourself if it's clearly in scope and safe, otherwise ask the user. Never tell the grunt to do it. Then continue its session. RULE BROKEN means it committed anyway: undo the commit or keep it deliberately.
Write a self-contained brief for each task (it can't see this conversation).`;

const server = new McpServer({ name: "opencode-delegate", version: pkg.version }, { instructions: INSTRUCTIONS });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const errText = (e: unknown) => text(e instanceof Error ? e.message : String(e), true);

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

/** Sends a progress notification every 15s while `work` runs; a keep-alive for clients that reset their timeout on progress. */
async function withHeartbeat<T>(extra: Extra, message: (secs: number) => string, work: () => Promise<T>): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  let tick = 0;
  const heartbeat =
    progressToken !== undefined
      ? setInterval(() => {
          tick++;
          extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: tick, message: message(tick * 15) } }).catch(() => {});
        }, 15000)
      : undefined;
  try {
    return await work();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

const delegateShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Complete, self-contained brief for the opencode model. It cannot see this conversation: include goal, relevant files/paths, constraints, how to verify, and ask for a short report at the end.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      `Exact 'provider/model' id or a loose name ('opus 5.5', 'kimi k3'). Append '#variant' for a reasoning variant. Omit to use the default (${config.defaultModel ?? "opencode's configured default"}).`,
    ),
  cwd: z.string().optional().describe("Working directory (absolute, or relative to the project). Defaults to the current project."),
  agent: z.string().optional().describe("opencode agent to use (e.g. 'build', 'plan', or a custom agent)."),
  files: z.array(z.string()).optional().describe("Files to attach to the message."),
  session_id: z.string().optional().describe("Continue an existing opencode session (from a previous result) for follow-ups."),
  continue: z.boolean().optional().describe("Continue the most recent opencode session in cwd."),
  fork: z.boolean().optional().describe("Fork the session given by session_id/continue instead of appending to it."),
  auto: z
    .boolean()
    .optional()
    .describe(`Auto-approve edits and shell commands that opencode's config doesn't deny. Default: ${config.auto}. Set false for read-only work (reviews, questions, research).`),
  title: z.string().optional().describe("Session title shown in opencode."),
  timeout_s: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Hard cap in seconds. Default: ${config.timeoutSec || "none"}. Rarely needed: a run is only killed as stuck after ${config.idleSec}s without output, so long healthy runs are left alone.`,
    ),
};

server.registerTool(
  "list_models",
  {
    title: "List opencode models",
    description: "List the models available in the local opencode install, as 'provider/model' ids.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive substring filter, e.g. 'opus' or 'openrouter/'."),
      refresh: z.boolean().optional().describe("Bypass the 5 minute cache."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ filter, refresh }) => {
    try {
      let models = await listModels(refresh);
      if (filter) models = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
      return text(models.length ? models.join("\n") : "(no models match)");
    } catch (e) {
      return errText(e);
    }
  },
);

server.registerTool(
  "delegate",
  {
    title: "Delegate a task to opencode",
    description:
      "Hand a task to an opencode model and wait for it. It works in `cwd` with its own read/edit/shell tools, so it can implement, not just answer. Only use when the user has asked for opencode. Returns its final answer, session_id, token usage and git changes. It implements only: run the tests, lint and build yourself afterwards. Prefer delegate_async for anything longer than a few minutes.",
    inputSchema: delegateShape,
  },
  async (input, extra) => {
    let progress: Progress | undefined;
    const message = (s: number) => `opencode running (${s}s)${progress ? `  ${formatProgress(progress)}` : ""}`;
    try {
      const outcome = await withHeartbeat(extra, message, () => delegate(input, extra.signal, { onProgress: (p) => (progress = p) }));
      return text(formatOutcome(outcome), !outcome.result.ok);
    } catch (e) {
      return errText(e);
    }
  },
);

function taskSummary(t: Task): string {
  const secs = (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(0);
  const model = t.outcome?.model ?? t.input.model ?? "(default)";
  const progress = t.status === "running" && t.progress ? `  ${formatProgress(t.progress)}` : "";
  return `${t.id}  ${t.status.padEnd(9)} ${secs}s${progress}  ${model}  ${t.input.title ?? t.input.prompt.slice(0, 60).replace(/\s+/g, " ")}`;
}

server.registerTool(
  "delegate_async",
  {
    title: "Start an opencode task in the background",
    description:
      "Same as delegate, but returns a task_id immediately so you can keep working while opencode runs. Collect the output with task_result. Use for long jobs and for fanning out several tasks at once; parallel tasks that edit files need separate worktrees or non-overlapping files.",
    inputSchema: delegateShape,
  },
  async (input) => {
    const t = startTask(input);
    return text(`started ${t.id}\nCall task_result with task_id="${t.id}" (optionally wait_s) to get the output.`);
  },
);

server.registerTool(
  "task_result",
  {
    title: "Get a background opencode task's result",
    description:
      "Return the status/result of a delegate_async task, optionally waiting up to wait_s seconds for it to finish. While running it shows live progress: steps, tool calls, file edits, context compactions, context size and time since the last activity.",
    inputSchema: {
      task_id: z.string(),
      wait_s: z
        .number()
        .int()
        .min(0)
        .max(3600)
        .optional()
        .describe("Seconds to wait for completion before returning (default 0). Progress notifications are sent every 15s while waiting."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_id, wait_s }, extra) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    await withHeartbeat(extra, () => taskSummary(t), () => waitTask(t, wait_s ?? 0));
    if (t.status === "running") return text(`${taskSummary(t)}\nstill running, call again later or with a larger wait_s.`);
    if (t.outcome) return text(`task: ${t.id} (${t.status})\n${formatOutcome(t.outcome)}`, t.status !== "done");
    return text(`task: ${t.id} (${t.status})\nerror: ${t.error}`, true);
  },
);

server.registerTool(
  "task_list",
  {
    title: "List background opencode tasks",
    description: "List delegate_async tasks started by this server with their status.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const all = listTasks();
    return text(all.length ? all.map(taskSummary).join("\n") : "(no tasks)");
  },
);

server.registerTool(
  "task_cancel",
  {
    title: "Cancel a background opencode task",
    description: "Stop a running delegate_async task.",
    inputSchema: { task_id: z.string() },
  },
  async ({ task_id }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    if (t.status !== "running") return text(`${t.id} already ${t.status}`);
    t.controller.abort();
    await waitTask(t, 5);
    return text(`${t.id} ${t.status === "running" ? "cancelling" : t.status}`);
  },
);

server.registerTool(
  "list_sessions",
  {
    title: "List opencode sessions",
    description: "List recent opencode sessions for a project directory (to find a session_id to continue).",
    inputSchema: {
      cwd: z.string().optional().describe("Project directory. Defaults to the current project."),
      limit: z.number().int().positive().max(100).optional().describe("Max sessions (default 20)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ cwd, limit }) => {
    const dir = resolve(config.defaultCwd, cwd ?? ".");
    const r = await execText(["session", "list", "-n", String(limit ?? 20)], dir);
    if (r.code !== 0) return text(r.stderr.trim() || `exit ${r.code}`, true);
    return text(r.stdout.trim() || "(no sessions)");
  },
);

await server.connect(new StdioServerTransport());
