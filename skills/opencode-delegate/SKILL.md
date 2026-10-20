---
name: opencode-delegate
description: Delegate coding, research or review work to an opencode model through the opencode MCP tools while Claude stays the orchestrator. opencode bills separately, so use this proactively whenever a task would burn a lot of this session's tokens (implementing a well-understood change, writing tests, refactors, reading lots of code, digesting logs, second-opinion reviews), and whenever the user says "use opencode", "delegate this", "have opencode do it", "ask <model> via opencode", or wants several models compared.
---

# Delegating to opencode

The `opencode` MCP server runs tasks with `opencode run` in the project. The delegated model has its own read/edit/shell tools, so it can implement, not just answer. Its tokens don't come out of this session's budget, so the more expensive part of a task should go there. **You stay the orchestrator**: plan, brief, review.

## When to delegate

Delegate by default when the work is token-heavy and doesn't need this conversation's judgment at every step:

- implementing a change you already understand
- writing or fixing tests, mechanical refactors, renames across many files
- reading a lot of code to answer a question, summarising big files or logs
- second-opinion reviews of a diff (`auto: false`)

Keep it yourself when it's a tiny edit cheaper than writing a brief, when it needs context only this conversation has, or when it's security-sensitive.

## Tools

| Tool | Use |
|---|---|
| `delegate_async` → `task_result` (`wait_s`) | Default. Start it, keep working, collect later. Also `task_list`, `task_cancel`. |
| `delegate` | Short jobs where you'd only sit and wait anyway. |
| `list_models` (`filter?`) | Find a `provider/model` id. |
| `list_sessions` | Find a `session_id` to continue. |

In a plugin install the tools are named like `mcp__plugin_opencode-subagent_opencode__delegate_async`.

## Picking the model

- Omit `model` unless the user named one. The configured default is used.
- Loose names work: `"opus 5.5"`, `"kimi k3"`. If a model comes from several providers, the maker's own provider wins over resellers, and a provider word in the name overrides that. Versions must match exactly.
- An **ambiguous** error lists candidates. Pick the one that fits, and ask only if intent is unclear.
- `#variant` picks a reasoning variant, e.g. `"provider/model#high"`.

## Writing the brief (`prompt`)

The delegated model **cannot see this conversation**. Brief it like a new hire:

1. **Goal**: what to build or find, and why.
2. **Context**: relevant paths, patterns to follow, build and test commands. If you already know the fix, say what to change and where. Don't delegate understanding you already have.
3. **Constraints**: what not to touch, the style to match, and "don't commit".
4. **Done when**: concrete acceptance criteria ("`bun test` passes").
5. **Report**: end with a short summary of what changed and anything left undone.

Use `files` to attach key files. Keep `cwd` at the project root unless the task is scoped to a subdirectory.

## Permissions

`auto` defaults to true, so the model edits and runs commands without asking. Rules opencode's config denies are still enforced. Use `auto: false` for read-only work.

## After it returns: review, don't trust blindly

The result has status, `session_id`, token usage, tools used and **git changes**.

1. Read the diff for the files it lists.
2. Run the tests or build yourself.
3. To fix something, continue the **same session** (`session_id`) with precise feedback, or fix it yourself if that's quicker.
4. Tell the user which model did what, and your verdict.

If a run fails or times out, say so plainly with the error. Don't present a failure as a result.

## Parallel work

- **Fan out**: one `delegate_async` per subtask, then `task_result` for each. Tasks that edit files need **separate git worktrees** or non-overlapping files.
- **Compare**: the same brief to 2–3 models in separate worktrees, then diff and pick.
- **Subagents / workflows**: the `opencode-worker` agent wraps this whole loop. Put the task (and a model, if wanted) in its prompt.
