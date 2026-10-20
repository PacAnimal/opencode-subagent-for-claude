# opencode delegation is available. Use it by default.

The `opencode` MCP tools (`delegate_async`, `delegate`, `task_result`) run work on a separate opencode model with its own billing. Anything done there costs none of this session's context window or usage limits. So:

- **Before doing token-heavy work yourself, delegate it.** That covers implementing a change you already understand, writing or fixing tests, mechanical refactors, reading through a lot of code to answer a question, digesting big logs or files, and drafting docs.
- **Get second opinions there too**: `auto: false` for read-only reviews and research.
- **Stay the orchestrator.** Gather just enough context, write a self-contained brief (it can't see this conversation), start it with `delegate_async`, keep working or wait with `task_result`, then review the git diff and run the tests yourself.
- **Do it yourself only** when the task needs this conversation's judgment at every step, when it's a tiny edit cheaper than writing a brief, or when it's security-sensitive.

The `opencode-delegate` skill has the full procedure.
