import { describe, expect, test } from "bun:test";
import { formatOutcome, pickModel, type DelegateOutcome } from "../src/delegate.ts";
import type { RunResult } from "../src/opencode.ts";

const cfg = (over: Partial<{ auto: boolean; defaultModel?: string; readModel?: string }>) =>
  ({ auto: true, defaultModel: "p/edit", readModel: "p/read", ...over }) as any;

describe("pickModel", () => {
  test("explicit model wins", () => {
    expect(pickModel({ model: "x/y", auto: false }, cfg({}))).toBe("x/y");
  });
  test("editing runs use the default model", () => {
    expect(pickModel({}, cfg({}))).toBe("p/edit");
    expect(pickModel({ auto: true }, cfg({ auto: false }))).toBe("p/edit");
  });
  test("read-only runs use the read model", () => {
    expect(pickModel({ auto: false }, cfg({}))).toBe("p/read");
    expect(pickModel({}, cfg({ auto: false }))).toBe("p/read");
  });
  test("nothing configured leaves it to opencode", () => {
    expect(pickModel({}, cfg({ defaultModel: undefined, readModel: undefined }))).toBeUndefined();
  });
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  sessionId: "ses_1",
  text: "all good",
  toolCalls: [
    { tool: "edit", status: "completed" },
    { tool: "edit", status: "completed" },
    { tool: "bash", status: "completed" },
  ],
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 90, cacheWrite: 0 },
  cost: 0,
  steps: 3,
  exitCode: 0,
  timedOut: false,
  durationMs: 12340,
  ...over,
});

describe("formatOutcome", () => {
  test("summary lines and response", () => {
    const o: DelegateOutcome = { model: "p/m", cwd: "/w", result: result(), changedFiles: [" M src/a.ts", "?? src/b.ts"] };
    const s = formatOutcome(o);
    expect(s).toContain("status: ok");
    expect(s).toContain("session_id: ses_1");
    expect(s).toContain("tokens in/out: 100/5");
    expect(s).toContain("tools used: edit×2, bash×1");
    expect(s).toContain("git changes:\n   M src/a.ts\n  ?? src/b.ts");
    expect(s).toEndWith("--- response ---\nall good");
  });
  test("errors and no git changes", () => {
    const s = formatOutcome({ cwd: "/w", result: result({ ok: false, error: "timed out after 5s", toolCalls: [] }), changedFiles: [] });
    expect(s).toContain("status: error");
    expect(s).toContain("model: (opencode default)");
    expect(s).toContain("error: timed out after 5s");
    expect(s).toContain("git changes: none");
    expect(s).not.toContain("tools used");
  });
  test("long responses are truncated", () => {
    const s = formatOutcome({ cwd: "/w", result: result({ text: "x".repeat(50) }) }, 20);
    expect(s).toContain("[truncated 30 chars");
  });
});
