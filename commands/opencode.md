---
description: Delegate a task to opencode (e.g. /opencode add input validation to the signup form, or /opencode kimi k3 -- write tests for src/date.ts)
argument-hint: "[model --] <task>"
---

Delegate this to opencode, following the opencode-delegate skill: $ARGUMENTS

If there's a `--`, the text before it is the model name. Pass it to the tool unchanged. Without `--`, the whole text is the task and `model` is omitted.

Expand the task into a self-contained brief using what you know about this project, then start it with `delegate_async` and collect it with `task_result`. When it's done, review its git changes, run the relevant tests, and give me a short summary: which model did it, what changed, and your verdict.
