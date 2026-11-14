import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lowPriorityCommand, runOpencode, watchdog } from "../src/opencode.ts";

describe("watchdog", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("fires after the quiet period", () => {
    let fired = 0;
    watchdog(1000, () => fired++);
    jest.advanceTimersByTime(999);
    expect(fired).toBe(0);
    jest.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });
  test("each kick restarts the clock", () => {
    let fired = 0;
    const w = watchdog(1000, () => fired++);
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(900);
      w.kick();
    }
    expect(fired).toBe(0);
    jest.advanceTimersByTime(1000);
    expect(fired).toBe(1);
  });
  test("stop disarms it", () => {
    let fired = 0;
    watchdog(1000, () => fired++).stop();
    jest.advanceTimersByTime(5000);
    expect(fired).toBe(0);
  });
  test("no limit never fires", () => {
    let fired = 0;
    const w = watchdog(undefined, () => fired++);
    w.kick();
    jest.advanceTimersByTime(1e9);
    expect(fired).toBe(0);
  });
});

describe("runOpencode with a fake binary", () => {
  const bin = fileURLToPath(new URL("./fixtures/fake-opencode", import.meta.url));
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-"));
    log = join(dir, "args.log");
    process.env.FAKE_LOG = log;
  });
  afterEach(() => {
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
  // a killed process stays a zombie until its new parent reaps it, and signal 0 still reaches a zombie
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    return !r.stdout.trim().startsWith("Z");
  };
  // the group is signalled when the run is cancelled, so give its members a moment to exit
  const gone = async (pid: number, ms = 2000) => {
    for (const end = Date.now() + ms; alive(pid) && Date.now() < end; ) await Bun.sleep(20);
    return !alive(pid);
  };
  const niceness = () => Number(readFileSync(`${log}.nice`, "utf8"));

  test("a silent run is killed as stalled", async () => {
    process.env.FAKE_MODE = "hang";
    const r = await runOpencode({ prompt: "p", bin, idleMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toBe("stalled: no output for 0.2s");
  });
  test("a cancelled run takes the processes it started down with it", async () => {
    process.env.FAKE_MODE = "hang";
    const controller = new AbortController();
    // the first event comes after the child has started
    const r = await runOpencode({ prompt: "p", bin, idleMs: 60_000, signal: controller.signal, onProgress: () => controller.abort() });
    expect(r.error).toBe("cancelled");
    expect(await gone(Number(readFileSync(`${log}.child`, "utf8")))).toBe(true);
  });
  test("runs at the lowest priority", async () => {
    await runOpencode({ prompt: "p", bin, idleMs: 60_000 });
    expect(niceness()).toBe(process.platform === "darwin" ? 20 : 19);
  });
  test("low priority can be turned off", async () => {
    await runOpencode({ prompt: "p", bin, idleMs: 60_000, lowPriority: false });
    expect(niceness()).toBe(getPriority());
  });
  test("a run that finishes is untouched", async () => {
    const r = await runOpencode({ prompt: "p", bin, idleMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
  });
});

describe("lowPriorityCommand", () => {
  test("darwin adds background policy", () => {
    expect(lowPriorityCommand("oc", ["run"], "darwin")).toEqual(["/usr/sbin/taskpolicy", ["-b", "/usr/bin/nice", "-n", "20", "oc", "run"]]);
  });
  test("linux uses nice", () => {
    expect(lowPriorityCommand("oc", ["run"], "linux")).toEqual(["nice", ["-n", "19", "oc", "run"]]);
  });
  test("windows is lowered after spawn", () => {
    expect(lowPriorityCommand("oc", ["run"], "win32")).toEqual(["oc", ["run"]]);
  });
});
