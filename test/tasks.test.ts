import { expect, test } from "bun:test";
import type { DelegateOutcome } from "../src/delegate.ts";
import { getTask, listTasks, startTask, waitTask } from "../src/tasks.ts";

const outcome = (ok: boolean) => ({ cwd: "/w", result: { ok } }) as DelegateOutcome;

test("finished task reports done", async () => {
  const t = startTask({ prompt: "p" }, async () => outcome(true));
  expect(getTask(t.id)).toBe(t);
  await t.promise;
  expect(t.status).toBe("done");
  expect(t.finishedAt).toBeDefined();
});

test("failed run reports error", async () => {
  const t = startTask({ prompt: "p" }, async () => outcome(false));
  await t.promise;
  expect(t.status).toBe("error");
});

test("thrown error is kept", async () => {
  const t = startTask({ prompt: "p" }, async () => {
    throw new Error("no such model");
  });
  await t.promise;
  expect(t.status).toBe("error");
  expect(t.error).toBe("no such model");
});

test("abort cancels and wait returns early when not running", async () => {
  const t = startTask({ prompt: "p" }, (_, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(outcome(false)))));
  expect(t.status).toBe("running");
  t.controller.abort();
  await waitTask(t, 5);
  expect(t.status).toBe("cancelled");
  expect(listTasks()).toContain(t);
});
