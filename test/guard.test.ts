import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loopGuard, nudgePrompt, runGuarded, stallPrompt, wrapUpPrompt } from "../src/delegate.ts";
import type { EventCollector, Progress } from "../src/opencode.ts";

const bin = fileURLToPath(new URL("./fixtures/fake-opencode", import.meta.url));
let dir: string;
let log: string;

beforeEach(() => {
  // not a git repo, so git status never changes
  dir = mkdtempSync(join(tmpdir(), "guard-"));
  log = join(dir, "args.log");
  process.env.FAKE_LOG = log;
});
afterEach(() => {
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_STEPS;
  rmSync(dir, { recursive: true, force: true });
});

const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
// runs only; interrupts sent to the service are logged as `ARGS api …`
const calls = () => lines().filter((l) => !l.startsWith("ARGS api "));
const run = (mode: string, loopCompactions = 2, maxNudges = 2, extra = {}, stallSteps = 0, readSteps = 0) => {
  process.env.FAKE_MODE = mode;
  return runGuarded({ prompt: "refactor everything", bin, cwd: dir, idleMs: 60_000, ...extra }, { loopCompactions, stallSteps, readSteps, maxNudges });
};
const stall = (mode: string, stallSteps = 5, maxNudges = 2, auto = true) => run(mode, 2, maxNudges, { auto }, stallSteps);
const read = (mode: string, readSteps = 5, maxNudges = 2) => run(mode, 2, maxNudges, { auto: false }, 5, readSteps);

describe("loop guard", () => {
  test("a looping run is resumed with a nudge and recovers", async () => {
    const r = await run("recover");
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("fixed");
    expect(r.sessionId).toBe("ses_fake");
    expect(r.nudges).toBe(1);
    expect(r.steps).toBe(4 + 1);
    expect(r.toolCalls.map((t) => t.tool)).toEqual(["read", "shell", "read", "shell", "edit"]);
    expect(r.edits).toBe(1);
    expect(r.compactions).toBe(2);
    expect(r.tokens.output).toBe(5 * 10);
    const [first, second] = calls();
    expect(first).not.toContain("--session");
    expect(second).toContain("--session ses_fake");
    expect(second).toEndWith(`-- ${nudgePrompt(2).replaceAll("\n", " ")}`);
  });
  test("a stopped run is interrupted on the service before it is resumed", async () => {
    await run("recover");
    const [first, interrupt, second] = lines();
    expect(first).not.toContain("--session");
    expect(interrupt).toBe("ARGS api session.interrupt --param sessionID=ses_fake");
    expect(second).toContain("--session ses_fake");
  });
  test("gives up after maxNudges, keeping the session", async () => {
    const r = await run("loop", 2, 2);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("looping: compacted 2 times without changing any file");
    expect(r.sessionId).toBe("ses_fake");
    expect(r.nudges).toBe(2);
    expect(r.steps).toBe(3 * 4);
    expect(calls().length).toBe(3);
  });
  test("maxNudges 0 stops without resuming", async () => {
    const r = await run("loop", 2, 0);
    expect(r.ok).toBe(false);
    expect(r.nudges).toBe(0);
    expect(calls().length).toBe(1);
  });
  test("edits between compactions are never nudged", async () => {
    const r = await run("edits");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
    expect(r.compactions).toBe(3);
    expect(r.edits).toBe(3);
    expect(r.nudges).toBe(0);
    expect(calls().length).toBe(1);
  });
  test("loopCompactions 0 disables the guard", async () => {
    const r = await run("loop", 0);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
    expect(r.compactions).toBe(3);
    expect(r.nudges).toBe(0);
    expect(calls().length).toBe(1);
  });
  test("cancelling stops the whole thing", async () => {
    const controller = new AbortController();
    const onProgress = (p: Progress) => p.compactions >= 2 && controller.abort();
    const r = await run("recover", 2, 2, { signal: controller.signal, onProgress });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cancelled");
    expect(calls().length).toBe(1);
  });
  test("progress is aggregated across resumes", async () => {
    const seen: Progress[] = [];
    await run("recover", 2, 2, { onProgress: (p: Progress) => seen.push(p) });
    expect(seen.at(-1)).toMatchObject({ steps: 5, toolCalls: 5, edits: 1, compactions: 2, nudges: 1 });
  });
});

describe("stall guard", () => {
  test("a stalled run is resumed with a stall nudge and recovers", async () => {
    const r = await stall("stall-recover");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("fixed");
    expect(r.nudges).toBe(1);
    expect(r.stallNudges).toBe(1);
    expect(r.steps).toBe(5 + 1);
    expect(r.edits).toBe(1);
    expect(r.compactions).toBe(0);
    const [first, second] = calls();
    expect(first).not.toContain("--session");
    expect(second).toContain("--session ses_fake");
    expect(second).toEndWith(`-- ${stallPrompt(5).replaceAll("\n", " ")}`);
  });
  test("a run that edits periodically is never stall-nudged", async () => {
    process.env.FAKE_STEPS = "30";
    const r = await stall("steady");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
    expect(r.steps).toBe(30);
    expect(r.nudges).toBe(0);
    expect(calls().length).toBe(1);
  });
  test("stallSteps 0 disables the trigger", async () => {
    const r = await stall("stall", 0);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(12);
    expect(r.nudges).toBe(0);
    expect(calls().length).toBe(1);
  });
  test("read-only runs are never stall-nudged", async () => {
    const r = await read("stall", 0);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(12);
    expect(r.nudges).toBe(0);
    expect(calls().length).toBe(1);
  });
  test("gives up after maxNudges with the stalled error", async () => {
    const r = await stall("stall");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("stalled: 5 steps without changing any file");
    expect(r.sessionId).toBe("ses_fake");
    expect(r.nudges).toBe(2);
    expect(r.stallNudges).toBe(2);
    expect(r.steps).toBe(3 * 5);
    expect(calls().length).toBe(3);
  });
  test("stall and compaction nudges share one budget", async () => {
    const r = await stall("stall-loop", 5, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("looping: compacted 2 times without changing any file");
    expect(r.nudges).toBe(1);
    expect(r.stallNudges).toBe(1);
    expect(calls().length).toBe(2);
  });
});

describe("read budget", () => {
  test("a read-only run over budget is told to answer now, and does", async () => {
    const r = await read("stall-recover");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("fixed");
    expect(r.nudges).toBe(1);
    expect(r.steps).toBe(5 + 1);
    const [, second] = calls();
    expect(second).toContain("--session ses_fake");
    expect(second).toEndWith(`-- ${wrapUpPrompt(5).replaceAll("\n", " ")}`);
  });
  test("gives up after maxNudges with the over budget error", async () => {
    const r = await read("stall");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("over budget: 5 steps reading");
    expect(r.nudges).toBe(2);
    expect(calls().length).toBe(3);
  });
  test("auto runs ignore the read budget", async () => {
    const r = await run("stall", 2, 2, { auto: true }, 0, 5);
    expect(r.ok).toBe(true);
    expect(r.nudges).toBe(0);
  });
});

describe("loopGuard", () => {
  const state = (edits: number, compactions: number) => ({ edits, compactions }) as EventCollector;
  test("counts compactions since the last edit", () => {
    const check = loopGuard(2, dir);
    expect(check(state(0, 1))).toBeUndefined();
    expect(check(state(1, 1))).toBeUndefined();
    expect(check(state(1, 2))).toBeUndefined();
    expect(check(state(1, 3))).toBe("looping: compacted 2 times without changing any file");
  });
  test("0 never fires", () => {
    const check = loopGuard(0, dir);
    for (let i = 1; i < 10; i++) expect(check(state(0, i))).toBeUndefined();
  });
  test("counts steps since the last edit", () => {
    const check = loopGuard(0, dir, 3);
    expect(check(state(0, 0))).toBeUndefined();
    expect(check(state(0, 0))).toBeUndefined();
    expect(check(state(1, 0))).toBeUndefined();
    expect(check(state(1, 0))).toBeUndefined();
    expect(check(state(1, 0))).toBeUndefined();
    expect(check(state(1, 0))).toBe("stalled: 3 steps without changing any file");
  });
});
