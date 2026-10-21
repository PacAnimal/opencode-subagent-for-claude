import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractNeeds,
  formatOutcome,
  gitDiff,
  gitStatus,
  GRUNT_RULES,
  loopGuard,
  nudgePrompt,
  pickModel,
  READ_REPORT_FORMAT,
  READ_RULES,
  REPORT_FORMAT,
  withRules,
  wrapUpPrompt,
  type DelegateOutcome,
} from "../src/delegate.ts";
import type { EventCollector, RunResult } from "../src/opencode.ts";

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
  edits: 2,
  compactions: 0,
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
    expect(s).toContain("edits: 2, compactions: 0");
    expect(s).not.toContain("nudges");
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
  test("nudges are reported", () => {
    const s = formatOutcome({ cwd: "/w", result: result({ compactions: 3, nudges: 1 }) });
    expect(s).toContain("edits: 2, compactions: 3, nudges: 1");
  });
  test("long responses are truncated", () => {
    const s = formatOutcome({ cwd: "/w", result: result({ text: "x".repeat(50) }) }, 20);
    expect(s).toContain("[truncated 30 chars");
  });
});

describe("grunt rules", () => {
  test("appended to every editing brief", () => {
    const p = withRules("add a CSV export", true);
    expect(p).toStartWith("add a CSV export\n\n");
    expect(p).toEndWith(GRUNT_RULES);
  });
  test("leave running tests to the lead, but fixing what checks find to the grunt", () => {
    expect(GRUNT_RULES).toContain("Do not run tests; your lead runs them.");
    expect(GRUNT_RULES).toContain("you must fix what they report, as well as the failures and findings your lead sends you");
  });
  test("forbid running tests, and allow lint, format, type-check and build", () => {
    expect(GRUNT_RULES).toContain("Do not run tests");
    expect(GRUNT_RULES).toContain("You may run the project's linters, formatters, type checks and builds");
    expect(GRUNT_RULES).not.toContain("Do not run tests, linters");
  });
  test("ask which lint or build commands ran and whether they passed", () => {
    expect(REPORT_FORMAT).toContain("which lint, format, type-check or build commands you ran and whether they passed");
  });
  test("forbid commits, installs, config and git, and ask for Needs", () => {
    for (const s of ["Never commit", "tests", "linters", "install", "dependencies", "config", "git", "## Needs", "## Result"]) expect(GRUNT_RULES).toContain(s);
  });
  test("describe the incremental working method", () => {
    for (const s of ["How to work:", "Work in increments", "compacted", "re-read only the file you are about to edit", "edit/write tools"]) expect(GRUNT_RULES).toContain(s);
    expect(GRUNT_RULES).toEndWith(REPORT_FORMAT);
  });
  test("nudge prompt carries the count and the report format", () => {
    const p = nudgePrompt(2);
    expect(p).toStartWith("Your context has been compacted 2 times without you changing any file.");
    expect(p).toEndWith(REPORT_FORMAT);
  });
});

describe("read rules", () => {
  test("appended to every read-only brief instead of the grunt rules", () => {
    const p = withRules("review the diff", false);
    expect(p).toStartWith("review the diff\n\n");
    expect(p).toEndWith(READ_RULES);
    expect(p).not.toContain(GRUNT_RULES);
  });
  test("read whole files once, in parallel, change nothing, and answer under Result", () => {
    for (const s of ["Change nothing", "whole", "parallel", "re-read", "## Needs", "## Result"]) expect(READ_RULES).toContain(s);
    expect(READ_RULES).toContain("Do not run tests, linters, formatters");
    expect(READ_RULES).not.toContain("implementer");
    expect(READ_RULES).not.toContain("Work in increments");
    expect(READ_RULES).toEndWith(READ_REPORT_FORMAT);
  });
  test("wrap-up prompt carries the count and the read report format", () => {
    const p = wrapUpPrompt(30);
    expect(p).toStartWith("You have spent 30 steps reading.");
    expect(p).toEndWith(READ_REPORT_FORMAT);
  });
});

describe("extractNeeds", () => {
  test("pulls the Needs section up to the next heading", () => {
    expect(extractNeeds("did a thing\n\n## Needs\n- install jq\n- an API key\n\n## Result\nhalf done")).toBe("- install jq\n- an API key");
  });
  test("Needs at the end", () => {
    expect(extractNeeds("## Result\nnothing\n## Needs\nwrite access to config/")).toBe("write access to config/");
  });
  test("absent or empty means nothing", () => {
    expect(extractNeeds("## Result\nall done")).toBeUndefined();
    expect(extractNeeds("## Needs\n\n## Result\nok")).toBeUndefined();
    expect(extractNeeds("## Needs\nnone")).toBeUndefined();
  });
  test("needs show at the top of the formatted outcome", () => {
    const s = formatOutcome({ cwd: "/w", result: result({ text: "## Needs\n- install jq\n## Result\nblocked" }) });
    expect(s).toContain("NEEDS (handle these yourself or ask the user, then continue the session):\n- install jq");
    expect(s.indexOf("NEEDS")).toBeLessThan(s.indexOf("--- response ---"));
  });
});

test("commits made by opencode are flagged", () => {
  const s = formatOutcome({ cwd: "/w", result: result(), newCommits: ["abc1234 sneaky commit"] });
  expect(s).toContain("RULE BROKEN: opencode committed (undo or keep it yourself):\n  abc1234 sneaky commit");
  expect(formatOutcome({ cwd: "/w", result: result(), newCommits: [] })).not.toContain("RULE BROKEN");
});

describe("git snapshot", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitsnap-"));
    git("init", "-q");
    git("config", "user.email", "a@a.com");
    git("config", "user.name", "a");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const commit = (path: string, content: string) => {
    writeFileSync(join(dir, path), content);
    git("add", path);
    git("commit", "-qm", path);
  };

  test("editing an already-modified tracked file is reported", () => {
    commit("a.txt", "one\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const before = gitStatus(dir)!;
    writeFileSync(join(dir, "a.txt"), "three\n");
    expect(gitDiff(before, gitStatus(dir)!)).toEqual([" M a.txt"]);
  });

  test("editing an already-untracked file is reported", () => {
    writeFileSync(join(dir, "b.txt"), "one\n");
    const before = gitStatus(dir)!;
    writeFileSync(join(dir, "b.txt"), "two\n");
    expect(gitDiff(before, gitStatus(dir)!)).toEqual(["?? b.txt"]);
  });

  test("an untouched dirty file is not reported", () => {
    commit("a.txt", "one\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const before = gitStatus(dir)!;
    expect(gitDiff(before, gitStatus(dir)!)).toEqual([]);
  });

  test("a new file is reported", () => {
    commit("a.txt", "one\n");
    const before = gitStatus(dir)!;
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    expect(gitDiff(before, gitStatus(dir)!)).toEqual(["?? new.txt"]);
  });

  test("a deleted file is reported", () => {
    commit("a.txt", "one\n");
    const before = gitStatus(dir)!;
    unlinkSync(join(dir, "a.txt"));
    expect(gitDiff(before, gitStatus(dir)!)).toEqual([" D a.txt"]);
  });

  test("a content change to an already-dirty file counts as guard progress, no nudge", () => {
    commit("a.txt", "one\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const state = (edits: number, compactions: number) => ({ edits, compactions }) as EventCollector;
    const check = loopGuard(2, dir);
    expect(check(state(0, 1))).toBeUndefined();
    // changed via shell, not the edit tool; the status line stays " M a.txt"
    writeFileSync(join(dir, "a.txt"), "three\n");
    expect(check(state(0, 2))).toBeUndefined();
  });
});
