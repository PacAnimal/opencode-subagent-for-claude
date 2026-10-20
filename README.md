# opencode-subagent-for-claude

A Claude Code plugin that lets Claude hand work to any model in your [opencode](https://opencode.ai) install.

It's opt-in. Claude leaves opencode alone until you ask for it ("use opencode for this"). From then on, opencode is Claude's team of junior devs. Claude splits the work into scoped implementation tasks and runs many of them in parallel. opencode only implements; it never runs tests, linters or builds. Claude does all verification itself (tests, lint, build, diff review) and sends every failure back as more implementation work, until the checks pass.

Every brief gets a fixed rules block appended by the server:
- implement only, in scope
- never commit
- no tests, lint or builds
- no installs, config or other git changes

It also tells the grunt how to work on big tasks: one change at a time, reading only what the next change needs, so its context doesn't fill up with a survey of the whole codebase.

A grunt that needs something (a tool, a dependency, a config change, a decision) stops and lists it under `## Needs`. The server lifts that to the top of the result, and Claude handles it or asks you. The server also flags any commit a grunt made anyway as `RULE BROKEN`.

```
Claude Code ──MCP (stdio)──▶ opencode-delegate server (Bun) ──spawns──▶ opencode run --format json [--auto] …
```

It shells out to the `opencode` CLI, so your existing opencode auth, providers, agents, MCP servers and permission rules all apply.

## What you get

- **MCP tools**: `delegate`, `delegate_async`, `task_result`, `task_list`, `task_cancel`, `list_models`, `list_sessions`
- **Opt-in rule**: the server's MCP instructions tell Claude never to use it unasked, and once asked, to delegate all implementation while doing the verification itself
- **`opencode-delegate` skill**: the opt-in rule, the split between implementing and verifying, and the delegate-verify-send-back loop, how to brief, how to review
- **`opencode-worker` subagent**: leads one task through that loop, for workflows and fan-out
- **`/opencode` command**: `/opencode write tests for src/date.ts`, or `/opencode kimi k3 -- …` to pick a model

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- [opencode](https://opencode.ai) v2+ with at least one provider set up (`opencode models` lists something)

## Install

```text
/plugin marketplace add PacAnimal/opencode-subagent-for-claude
/plugin install opencode-subagent@opencode-subagent-for-claude
```

To use just the MCP server, without the plugin:

```bash
git clone https://github.com/PacAnimal/opencode-subagent-for-claude ~/.local/share/opencode-subagent-for-claude
claude mcp add opencode -s user -- bun ~/.local/share/opencode-subagent-for-claude/dist/index.js
```

## Big tasks

opencode compacts a session when its context fills. A grunt that keeps reading files can end up compacting, re-reading everything, and compacting again without ever making a change. The server watches for this; the brief needs nothing extra.

- **Live progress**: `task_list` and `task_result` show what a running task is doing, e.g. `running 2065s  steps 94  tools 100  edits 0  compactions 2  ctx 20k  last activity 12s ago`. `task_result` with `wait_s` and `delegate` send this as a progress notification every 15s, which also keeps clients from timing out.
- **Loop guard**: a compaction shows up as the context size collapsing between steps. Once a run compacts `OPENCODE_DELEGATE_LOOP_COMPACTIONS` times without an edit or any change in `git status`, it's stopped and the same session is resumed with a nudge to make the next change now. After `OPENCODE_DELEGATE_MAX_NUDGES` nudges it gives up with `looping: …`, keeping the session_id so Claude can continue it. All runs add up to one result, which reports edits, compactions and nudges.
- **Stall guard**: with a large context a run can read and think for dozens of steps without ever compacting or editing. Once an auto run goes `OPENCODE_DELEGATE_STALL_STEPS` steps without an edit or any change in `git status` (checked every few steps), it's stopped and the same session is resumed with a nudge to write the first file now and continue file by file. The count restarts after each nudge. Stall and loop nudges share the `OPENCODE_DELEGATE_MAX_NUDGES` budget; when it runs out the run gives up with `stalled: …`. Read-only runs (`auto: false`) are never stall-nudged.

## Model names

Pass exact ids (`openrouter/kimi-k3`) or loose names (`kimi k3`, `opus 5.5`). When a model is sold by several providers, the maker's own provider beats resellers, and a provider word in the name overrides that. Versions must match exactly. Dashed versions match dotted queries, so `opus 5.5` finds `claude-opus-5-5`. An ambiguous name returns candidates instead of a guess. Add `#variant` for a reasoning variant. With no model given, opencode's configured default is used unless you set one below.

## Permissions

Runs use `--auto` by default. The model edits files and runs commands without asking, but anything your opencode config denies stays denied. Pass `auto: false` (or set `OPENCODE_DELEGATE_AUTO=false`) for read-only runs.

## Configuration

Set these in the environment Claude Code runs in, e.g. the `env` block of `~/.claude/settings.json`.

| Variable | Default | |
|---|---|---|
| `OPENCODE_BIN` | auto-detected | Path to `opencode`. |
| `OPENCODE_DELEGATE_DEFAULT_MODEL` | opencode's default | Model used when none is given. |
| `OPENCODE_DELEGATE_READ_MODEL` | the default model | Model for read-only runs (`auto: false`) when none is given. |
| `OPENCODE_DELEGATE_AUTO` | `true` | Default for `auto`. |
| `OPENCODE_DELEGATE_IDLE_TIMEOUT` | `600` | A run that produces no output for this many seconds counts as stuck and is killed. `0` disables it. |
| `OPENCODE_DELEGATE_TIMEOUT` | `0` (none) | Optional hard cap in seconds, however busy the run is. |
| `OPENCODE_DELEGATE_LOOP_COMPACTIONS` | `2` | Compactions without a file change before a run counts as looping and gets nudged. `0` disables the loop guard. |
| `OPENCODE_DELEGATE_STALL_STEPS` | `40` | Steps without a file change before an auto run counts as stalled and gets nudged. `0` disables the stall guard. |
| `OPENCODE_DELEGATE_MAX_NUDGES` | `2` | Nudged resumes per task (loop and stall nudges together) before a run is given up. |
| `OPENCODE_DELEGATE_MAX_OUTPUT` | `40000` | Max response characters returned to Claude. |
| `OPENCODE_DELEGATE_CWD` | project dir | Base directory for `cwd`. |
| `OPENCODE_DELEGATE_PREFERRED_PROVIDERS` | none | Comma-separated provider order for models offered by several providers. |

## Development

```bash
bun install
bun run check   # typecheck, tests, build
```

`dist/index.js` is committed so plugin installs don't need a build step. CI fails if it's stale.

Based on [claude-opencode-delegate](https://github.com/aashahin/claude-opencode-delegate) (MIT).
