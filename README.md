# opencode-subagent-for-claude

A Claude Code plugin that lets Claude hand work to any model in your [opencode](https://opencode.ai) install.

It's opt-in. Claude leaves opencode alone until you ask for it ("use opencode for this"). From then on, opencode is Claude's team of junior devs. Claude splits the work into scoped implementation tasks and runs many of them in parallel. opencode only implements; it never runs tests, linters or builds. Claude does all verification itself (tests, lint, build, diff review) and sends every failure back as more implementation work, until the checks pass.

Every brief gets a fixed rules block appended by the server:
- implement only, in scope
- never commit
- no tests, lint or builds
- no installs, config or other git changes

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
| `OPENCODE_DELEGATE_TIMEOUT` | `1800` | Seconds before a run is killed. |
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
