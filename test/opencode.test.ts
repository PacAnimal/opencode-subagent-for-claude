import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildArgs, COMPACTION_MIN_CONTEXT, EventCollector, formatProgress, runEnv } from "../src/opencode.ts";

const collect = (fixture: string) => {
  const c = new EventCollector();
  for (const line of readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8").split("\n")) c.push(line);
  return c;
};

describe("EventCollector", () => {
  test("simple text reply", () => {
    const c = collect("simple.jsonl");
    expect(c.sessionId).toBe("ses_f323ce808ffeO9J3dh9kIrHUQN");
    expect(c.text).toBe("hi there");
    expect(c.errors).toEqual([]);
  });
  test("tool calls, tokens and steps", () => {
    const c = collect("tools.jsonl");
    expect(c.toolCalls.map((t) => t.tool)).toEqual(["write", "read"]);
    expect(c.toolCalls[0]?.status).toBe("completed");
    expect(c.steps).toBe(2);
    expect(c.tokens.input).toBe(30581 + 98);
    expect(c.tokens.cacheRead).toBe(256 + 30976);
    expect(c.text).toStartWith("Done.");
  });
  test("v2 run without a final step_finish", () => {
    const c = collect("v2.jsonl");
    expect(c.toolCalls.map((t) => t.tool)).toEqual(["read", "write"]);
    expect(c.steps).toBe(2);
    expect(c.tokens.cacheRead).toBe(13167 + 13303);
    expect(c.text).toStartWith("I read `probe.txt`");
  });
  test("only the final step's text is returned", () => {
    const c = new EventCollector();
    for (const e of [
      { type: "step_start" },
      { type: "text", part: { text: "let me look" } },
      { type: "step_finish", part: {} },
      { type: "step_start" },
      { type: "text", part: { text: "answer" } },
    ])
      c.push(JSON.stringify(e));
    expect(c.text).toBe("answer");
  });
  test("falls back to earlier text when the last step has none", () => {
    const c = new EventCollector();
    for (const e of [{ type: "step_start" }, { type: "text", part: { text: "answer" } }, { type: "step_start" }]) c.push(JSON.stringify(e));
    expect(c.text).toBe("answer");
  });
  test("error event", () => {
    const c = collect("error.jsonl");
    expect(c.errors).toEqual(["Model unavailable: nope/fake"]);
  });
  test("non-JSON output falls back to raw text", () => {
    const c = new EventCollector();
    c.push("plain output");
    expect(c.text).toBe("plain output");
  });
});

const step = (input: number, read = 0, write = 0) => JSON.stringify({ type: "step_finish", part: { tokens: { input, output: 1, reasoning: 0, cache: { read, write } } } });
const tool = (name: string) => JSON.stringify({ type: "tool_use", part: { tool: name, state: { status: "completed", input: {} } } });
const feed = (lines: string[]) => {
  const c = new EventCollector();
  for (const l of lines) c.push(l);
  return c;
};

describe("live progress", () => {
  test("context size is input plus cache of the last step", () => {
    const c = feed([step(100, 2000, 30), step(50, 4000, 10)]);
    expect(c.contextTokens).toBe(4060);
    expect(c.compactions).toBe(0);
  });
  test("a context collapsing below half counts as a compaction", () => {
    const c = feed([step(1000, 150_054), step(479, 20_000), step(1000, 90_000), step(1000, 160_000), step(500, 40_000)]);
    expect(c.compactions).toBe(2);
    expect(c.contextTokens).toBe(40_500);
  });
  test("small contexts never count", () => {
    const c = feed([step(COMPACTION_MIN_CONTEXT - 1), step(10), step(40_000), step(100)]);
    expect(c.compactions).toBe(0);
  });
  test("gradual growth and mild drops don't count", () => {
    const c = feed([step(60_000), step(80_000), step(120_000), step(70_000), step(150_000)]);
    expect(c.compactions).toBe(0);
  });
  test("edit-class tools are counted", () => {
    const c = feed(["write", "edit", "multiedit", "patch", "apply_patch", "read", "shell", "grep"].map(tool));
    expect(c.edits).toBe(5);
    expect(c.toolCalls.length).toBe(8);
  });
  test("fixture edits and last event time", () => {
    const c = collect("tools.jsonl");
    expect(c.edits).toBe(1);
    expect(c.lastEventAt).toBeNumber();
    expect(c.progress).toMatchObject({ steps: 2, toolCalls: 2, edits: 1, compactions: 0 });
  });
  test("progress line", () => {
    const p = { steps: 94, toolCalls: 100, edits: 0, compactions: 2, contextTokens: 20_479, lastEventAt: 1_000 };
    expect(formatProgress(p, 13_000)).toBe("steps 94  tools 100  edits 0  compactions 2  ctx 20k  last activity 12s ago");
    expect(formatProgress({ ...p, nudges: 1, lastEventAt: undefined })).toBe("steps 94  tools 100  edits 0  compactions 2  ctx 20k  nudges 1");
  });
});

describe("buildArgs", () => {
  test("full options", () => {
    expect(
      buildArgs({ prompt: "-do it", model: "a/b#high", agent: "build", sessionId: "ses_1", fork: true, auto: true, title: "t", files: ["/x"] }),
    ).toEqual(["run", "--format", "json", "--model", "a/b#high", "--agent", "build", "--session", "ses_1", "--fork", "--auto", "--title", "t", "--file", "/x", "--", "-do it"]);
  });
  test("minimal", () => {
    expect(buildArgs({ prompt: "hi" })).toEqual(["run", "--format", "json", "--", "hi"]);
  });
  test("fork without a session is dropped", () => {
    expect(buildArgs({ prompt: "hi", fork: true })).not.toContain("--fork");
  });
  test("session wins over continue", () => {
    const args = buildArgs({ prompt: "hi", sessionId: "s", continueLast: true });
    expect(args).toContain("--session");
    expect(args).not.toContain("--continue");
  });
});

describe("runEnv", () => {
  test("PWD follows cwd", () => {
    expect(runEnv("/work/b", { PWD: "/server/a", X: "1" })).toEqual({ PWD: "/work/b", X: "1" });
  });
  test("env untouched without cwd", () => {
    const env = { PWD: "/server/a" };
    expect(runEnv(undefined, env)).toBe(env);
  });
});
