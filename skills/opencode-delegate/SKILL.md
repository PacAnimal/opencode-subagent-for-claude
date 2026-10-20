---
name: opencode-delegate
description: Delegate implementation grunt work to opencode models (a team of junior devs you can run in parallel) while Claude orchestrates and does all verification (tests, lint, build, review). Use ONLY when the user explicitly asks for opencode ("use opencode", "have opencode do it", "delegate this to opencode", "ask <model> via opencode"). Never on your own initiative. Once asked, it is mandatory for all implementation work that can be delegated.
---

# Delegating to opencode

The `opencode` MCP server runs tasks with `opencode run` in the project. Each run is a junior dev with its own read/edit/shell tools. You can launch many of them at once. **You are the lead**: you split the work, brief, verify and send fixes back.

## When to use it

- **The user hasn't asked for opencode**: don't use it. Do the work yourself as usual.
- **The user has asked for opencode**: you MUST hand all implementation grunt work to it for as long as that instruction stands. Don't quietly fall back to writing the code yourself. If opencode fails, retry, or report it and ask.

## Who does what

| opencode (juniors) | You (lead) |
|---|---|
| Implementation: new code, changes, refactors, renames, boilerplate, test code, docs | Splitting the work and writing briefs |
| Fixing what you send back | Running tests, lint and build |
| | Reviewing every diff |
| | Deciding when it's done, and reporting to the user |

Grunts do grunt work, nothing more. They never run tests, linters or builds, never commit, never install anything, never change config or environment, and never judge whether their own work is done.

**The server enforces this.** It appends a fixed rules block to every brief, so you don't have to repeat it. The block tells the grunt to stay in scope, never commit, verify nothing, install nothing, leave config, git and the environment alone, and finish with `## Needs` and `## Result` sections. After the run, the server flags any commit it made anyway as `RULE BROKEN`. Undo that commit, or keep it deliberately, then tell the grunt not to do it again.

## When a grunt needs something

If a grunt needs a tool installed, a dependency added, config changed, access granted or a decision made, it stops and lists that under `## Needs`. The server lifts it into a **`NEEDS`** block at the top of the result. When you see one:

1. **Don't hand it back to the grunt**, and never tell a grunt to install or configure things itself.
2. **Handle it yourself** if it's clearly in scope and safe: a dev dependency the task obviously requires, a config line the change needs, a decision you can make from the conversation.
3. **Ask the user** for anything else: system-wide installs, new production dependencies, credentials or secrets, infrastructure or CI changes, anything you aren't sure they'd want.
4. **Then continue the same session** (`session_id`). Say what's now in place, and have it finish the implementation.

A grunt that worked around a need instead of reporting it (installed something, edited config it didn't own) broke the rules. Revert that part and redo it properly yourself.

## The loop

1. **Split** the work into scoped tasks with clear file boundaries.
2. **Launch** one `delegate_async` per task, in parallel. Tasks that edit files need **separate git worktrees** or non-overlapping files.
3. **Collect** with `task_result` (`wait_s`).
4. **Unblock**: handle every `NEEDS` block (see above) and continue those sessions.
5. **Verify yourself**: read the diff, then run the project's tests, lint and build.
6. **Send it back**: every failure, lint finding or review comment becomes a new implementation task in the **same session** (`session_id`). Paste the exact errors and say what to change.
7. **Repeat** from 3 until your verification is clean. Fix things yourself only when a task is trivial or opencode keeps failing at it, and tell the user when you do.

## Tools

| Tool | Use |
|---|---|
| `delegate_async` → `task_result` (`wait_s`) | The default. Fan out, keep working, collect. Also `task_list`, `task_cancel`. |
| `delegate` | A single short follow-up where you'd only sit and wait anyway. |
| `list_models` (`filter?`) | Find a `provider/model` id. |
| `list_sessions` | Find a `session_id` to continue. |

In a plugin install the tools are named like `mcp__plugin_opencode-subagent_opencode__delegate_async`.

## Picking the model

- Omit `model` unless the user named one. The configured default is used.
- Loose names work: `"opus 5.5"`, `"kimi k3"`. If a model comes from several providers, the maker's own provider wins over resellers, and a provider word in the name overrides that. Versions must match exactly.
- An **ambiguous** error lists candidates. Pick the one that fits, and ask only if intent is unclear.
- `#variant` picks a reasoning variant, e.g. `"provider/model#high"`.

## Writing the brief (`prompt`)

The junior **cannot see this conversation**. Brief it like a new hire:

1. **Goal**: what to build or change, and why.
2. **Context**: relevant paths, and patterns to follow. If you know the fix, say what to change and where.
3. **Scope**: the files it owns, and what not to touch. Keep to it, since other juniors work in parallel.
4. **Constraints**: the style to match. If the task really does need a config or manifest file edited, assign that file explicitly. Otherwise grunts leave config alone.

The rules block (no verifying, no commits, no installs, no config, Needs and Result sections) is appended for you.

Use `files` to attach key files. Keep `cwd` at the project root (or the task's worktree).

## Permissions

`auto` defaults to true, so the model edits files without asking. Rules opencode's config denies are still enforced. Use `auto: false` for read-only research.

## Reporting

Tell the user which tasks went to which model, what your verification found, how many rounds it took, and your verdict. If a run fails or times out, say so plainly with the error.
