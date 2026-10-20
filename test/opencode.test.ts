import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildArgs, EventCollector, runEnv } from "../src/opencode.ts";

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
