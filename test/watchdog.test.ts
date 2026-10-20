import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runOpencode, watchdog } from "../src/opencode.ts";

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
  afterEach(() => delete process.env.FAKE_MODE);

  test("a silent run is killed as stalled", async () => {
    process.env.FAKE_MODE = "hang";
    const r = await runOpencode({ prompt: "p", bin, idleMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toBe("stalled: no output for 0.2s");
  });
  test("a run that finishes is untouched", async () => {
    const r = await runOpencode({ prompt: "p", bin, idleMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
  });
});
