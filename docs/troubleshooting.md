# Troubleshooting

Start with a machine-readable report from a plugin checkout, in the same
environment that will run the adapter:

```bash
npm ci
npm run build
node lib/cli.js doctor --json
```

DSH 0.2 resolves its own packages only inside the `dsh` launcher. Through
`dsh plugin --profile web exec dsh-claude-plugin doctor`, the doctor exits `2`
and reports that it must run from a plugin checkout after `npm ci`.

Use `--no-live` for a keyless structural check and `--live` for conclusive
authentication. Doctor exits `0` for `PASS` or diagnostic `WARN`, `1` when any
check fails, and `2` for invalid command usage.

## Doctor checks

| Check | Failure meaning | Corrective action |
| --- | --- | --- |
| `runtime.node` | Node is outside `^22.19.0 || >=24.0.0` | Install a supported Node release, reinstall dependencies, rerun doctor. |
| `package.sdk` | Installed Agent SDK differs from the exact package pin | Run `npm ci` or reinstall the exact plugin artifact; do not override its SDK dependency. |
| `package.dsh-peers` | A required DSH/Cordis peer is absent or outside its declared range | Run `npm ci` in the checkout. In a profile, `dsh plugin add` and profile startup enforce the ranges for DSH `0.2.0-rc.2`. |
| `executable.resolve` | Host `claude` is missing, or fallback policy was used | Install Claude Code or select `--policy bundled-only`/`host-then-bundled` intentionally. |
| `executable.version` | Version output is invalid, timed out, or differs from bundled parity | Upgrade the host CLI; version skew is a warning only when the CLI otherwise works. |
| `auth.metadata` | `claude auth status --json` is logged out or invalid | Run `claude auth login`; never copy credential files into the plugin. |
| `spawn.lifecycle` | A metadata subprocess timed out or exited by signal | Run the same CLI command directly, inspect enterprise/runtime policy, and fix the executable before DSH. |
| `sdk.startup` | Agent SDK did not emit initialization | Check executable policy, package pin, Node version, cwd access, and process policy. |
| `mcp.handshake` | The DSH MCP server disconnected or a native/non-DSH tool appeared | Stop: this is an authority-boundary failure. Preserve the report and file an issue. |
| `generation.live` | Exact live generation failed | Reauthenticate, verify account/model access, then compare direct Claude and plugin smoke results. |
| `process.cleanup` | The SDK child required forced termination or cleanup was unconfirmed | Stop the profile and inspect remaining Claude processes before retrying. |

`auth.metadata: PASS` is not proof of usable authentication. A stale OAuth
session can report logged in and still fail the live request. Only
`generation.live: PASS` establishes readiness.

## Stable adapter error codes

| Code | Meaning and first action |
| --- | --- |
| `CLAUDE_ABORTED` | DSH or the caller cancelled the generation. Retry only after confirming no child remains. |
| `CLAUDE_AUTHENTICATION_FAILED` | Claude rejected credentials. Run `claude auth login`, then live doctor. |
| `CLAUDE_EXECUTABLE_NOT_FOUND` | The configured host command is unavailable. Fix `claudeCommand` or executable policy. |
| `CLAUDE_INVALID_CONFIG` | Plugin configuration failed validation. Correct the named field; do not bypass validation. |
| `CLAUDE_INVALID_MODEL`, `CLAUDE_MODEL_NOT_FOUND`, `CLAUDE_INVALID_PROVIDER` | The selected route/model is unsupported. Select `claude-code/default`, `sonnet`, `opus`, or `haiku`. |
| `CLAUDE_PROTOCOL_ERROR` | Claude/SDK emitted an event sequence the pinned bridge cannot safely interpret. Capture versions and sanitized diagnostics. |
| `CLAUDE_TOOL_PROTOCOL_ERROR` | Tool ID, name, arguments, catalog generation, or result correlation failed. The bridge closes instead of guessing. |
| `CLAUDE_TOOL_TIMEOUT` | DSH did not return the correlated tool result before `toolRoundTripTimeoutMs`. Inspect approval/tool state. |
| `CLAUDE_TRANSPORT_ERROR` | The managed CLI/SDK transport failed. Compare direct smoke, doctor, exit status, and cleanup. |
| `CLAUDE_TRANSPORT_NOT_IMPLEMENTED` | An adapter scaffold without the managed SDK transport was installed. Upgrade to the current plugin artifact. |
| `CLAUDE_UNSUPPORTED_INPUT` | Content, MIME type, dimensions, size, or replay representation is unsupported. Reduce/convert the input. |
| `CLAUDE_COLD_REPLAY_UNSUPPORTED` | Durable history cannot be represented by the bounded replay envelope. Start a clean session or simplify history. |
| `CLAUDE_IN_FLIGHT_RECOVERY_UNSUPPORTED` | A restart found an unresolved tool/generation boundary. Resolve by starting a clean generation; no result is fabricated. |
| `CLAUDE_USAGE_EPOCH_RESET` | Cumulative SDK counters regressed unexpectedly. Treat usage for that epoch as invalid and capture versions. |
| `CLAUDE_RATE_LIMITED` | Claude rejected the request for quota/rate reasons. Retry according to the account's provider guidance. |

## Installation/profile failures

### `pnpm not found`

`dsh plugin` deliberately delegates package management to `pnpm`. Install it
on `PATH`, verify `pnpm --version` outside this npm-managed repository, and
repeat the same profile command.

### Plugin installs but Claude is not selectable

Dump the effective tree without booting DSH:

```bash
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config
```

The tree must contain exactly one `llm-claude-code` row named
`dsh-claude-plugin`. If the row is absent, inspect the profile's dependency and
bundle list with `dsh plugin --profile web why dsh-claude-plugin`. If the row is
present but another provider is selected, a later user/profile overlay is
intentionally taking precedence.

### Profile verifier rejects the transition

Do not weaken the verifier. Remove the plugin, confirm restoration, then retry
from a clean baseline. Codes beginning `PROFILE_ROW_` mean install altered an
unexpected row or order; `PROFILE_REMOVE_` means removal did not exactly restore
the prior semantic tree. `PROFILE_*_INVALID` means a dump is malformed,
duplicated, unsupported, or larger than 8 MiB.

### WebUI says `Failed to fetch (internal)`

Treat this as a server-side symptom, not an authentication diagnosis:

1. identify the process listening on port 3080 and its cwd;
2. confirm it uses the intended DSH version/profile and plugin artifact;
3. run the doctor from a plugin checkout;
4. inspect sanitized server logs for a stable adapter code;
5. reproduce a direct Claude generation with the same model.

Do not test a new checkout against an old listener. Restart only the verified
target process and prove it has exited before relaunching.

## What a useful issue report contains

Include the plugin commit/version, DSH/SDK/Claude versions, OS/architecture,
Node version, doctor JSON, effective-profile verifier result, stable error code,
and whether direct Claude succeeds. Remove prompts, tool arguments/results,
paths containing personal identifiers, credentials, and environment values.
