---
description: Hand implementation to opencode while Claude verifies (e.g. /opencode add input validation to the signup form, or /opencode kimi k3 -- add a CSV export)
argument-hint: "[model --] <task>"
---

Use opencode for this, following the opencode-delegate skill: $ARGUMENTS

If there's a `--`, the text before it is the model name. Pass it to the tool unchanged. Without `--`, the whole text is the task and `model` is omitted.

Split the task into scoped implementation tasks, brief each one using what you know about this project, and launch them with `delegate_async`. The server appends the grunt rules for you. Handle any `NEEDS` they report yourself, or ask me, then continue those sessions. When they're done, run the tests yourself and review the diff (re-run lint as a final gate if you like). Send test failures, review findings and any lint or build failures back as new implementation tasks in the same sessions until everything is clean. Then give me a short summary: which model did what, how many rounds it took, and your verdict.
