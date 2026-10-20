#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.ts";
import { delegate, formatOutcome } from "./delegate.ts";
import { listModels } from "./models.ts";
import { execText } from "./opencode.ts";
import { getTask, listTasks, startTask, waitTask, type Task } from "./tasks.ts";
import pkg from "../package.json" with { type: "json" };

// shown to the host model in its system prompt
const INSTRUCTIONS = `Delegate to opencode by default. opencode runs on its own provider and billing, so work done there costs none of this session's context or usage budget.
Use delegate_async (or delegate for short jobs) for anything token-heavy that doesn't need your judgment on every step: implementing a well-understood change, writing tests, refactors, broad code reading/research, summarising large files or logs, second-opinion reviews (auto: false).
You stay the orchestrator: write a self-contained brief (the model can't see this conversation), then review the git changes and run the tests yourself before reporting.
Keep for yourself: decisions that need this conversation's context, tiny edits cheaper to do than to brief, and anything security-sensitive.`;

const server = new McpServer({ name: "opencode-delegate", version: pkg.version }, { instructions: INSTRUCTIONS });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const errText = (e: unknown) => text(e instanceof Error ? e.message : String(e), true);

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
  timeout_s: z.number().int().positive().optional().describe(`Kill the run after this many seconds. Default: ${config.timeoutSec}.`),
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
      "Hand a task to an opencode model and wait for it. It works in `cwd` with its own read/edit/shell tools, so it can implement, not just answer, and it doesn't spend this session's tokens. Returns its final answer, session_id, token usage and git changes. Review the changes afterwards. Prefer delegate_async for anything longer than a few minutes.",
    inputSchema: delegateShape,
  },
  async (input, extra) => {
    const progressToken = extra._meta?.progressToken;
    let tick = 0;
    // keep-alive for clients that reset their timeout on progress
    const heartbeat = progressToken
      ? setInterval(() => {
          tick++;
          extra
            .sendNotification({ method: "notifications/progress", params: { progressToken, progress: tick, message: `opencode running (${tick * 15}s)` } })
            .catch(() => {});
        }, 15000)
      : undefined;
    try {
      const outcome = await delegate(input, extra.signal);
      return text(formatOutcome(outcome), !outcome.result.ok);
    } catch (e) {
      return errText(e);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  },
);

function taskSummary(t: Task): string {
  const secs = (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(0);
  const model = t.outcome?.model ?? t.input.model ?? "(default)";
  return `${t.id}  ${t.status.padEnd(9)} ${secs}s  ${model}  ${t.input.title ?? t.input.prompt.slice(0, 60).replace(/\s+/g, " ")}`;
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
    description: "Return the status/result of a delegate_async task, optionally waiting up to wait_s seconds for it to finish.",
    inputSchema: {
      task_id: z.string(),
      wait_s: z.number().int().min(0).max(3600).optional().describe("Seconds to wait for completion before returning (default 0)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_id, wait_s }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    await waitTask(t, wait_s ?? 0);
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
