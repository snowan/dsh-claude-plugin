# dsh-claude-plugin

A from-scratch DeepSeek Harness adapter for running Claude Code as the primary
LLM route while preserving DSH's agent loop, tools, permissions, sessions, and
WebUI.

The design and implementation are being developed in small, independently
tested pull requests. No source code is copied from another plugin or project.

Developed by [snowan](https://github.com/snowan) with Codex assistance.

## Status

The package registers the `claude-code` provider and runs Claude turns through
the pinned Claude Agent SDK and DSH's managed subprocess and attachment
services. It streams text, thinking, raw tool calls, per-turn token usage, and
one terminal result while retaining one serialized SDK query per live DSH
session. The route advertises text and image input.

DSH tools are exposed through one in-process MCP server. Claude's native tools,
ambient MCP servers, settings, hooks, plugins, and main-session skills remain
disabled. Each MCP handler pauses until DSH executes the visible tool call and
returns the exact correlated result; the same Claude query then resumes.

DSH 0.2 sends the system prompt as the leading `system` message of each
request and each tool result as a `tool`-role message. The adapter maps the
leading system message to the Claude system prompt and each tool-role message
to the pending MCP call it answers. The route declares no mid-conversation
system prompt or tool-update mode, so a later `system` message or a
`developer` tool-update message fails with `CLAUDE_UNSUPPORTED_INPUT`. Images
that DSH has offloaded reach Claude as DSH's placeholder text.

The lifecycle milestone adds bounded session reuse and restart recovery. Every
successful step carries a versioned replay anchor bound to the DSH prefix,
assistant content, system prompt, working directory, safe Claude session/fork
point, model, and cumulative usage snapshot. A matching cold continuation forks
the stored Claude transcript and sends only new user input. Divergent, compacted,
imported, or unavailable transcripts use one length-bounded canonical user-role
replay envelope; assistant-role SDK input is never fabricated.

Settled sessions are evicted after the configured idle interval. A query parked
at a DSH-owned tool boundary is protected from idle eviction, but still obeys
the tool-result timeout. Cancellation, timeout, process failure, and plugin
disposal close the query and managed process tree. One retry is allowed only
before the current generation emits any observable chunk.

The content milestone preserves PNG, JPEG, WebP, and GIF prompt images from
DSH's durable attachment store. DSH tool results can return MCP text, image,
embedded-resource, resource-link, structured, and explicit error content.
Claude thinking is retained as DSH reasoning when the selected model exposes
it, and `low`, `medium`, and `high` effort can be selected through DSH model
configuration.

The package now includes a bounded `doctor`, semantic profile transition
verification, isolated packed-tarball install/removal and WebUI gates, and a
paired direct-Claude parity benchmark. Unsupported content or recovery state
fails closed with a stable diagnostic rather than being silently dropped or
bypassing DSH.

## Requirements

- Node.js `22.19+` or `24+`
- DeepSeek Harness `0.2.0-rc.2`
- Claude Code CLI authenticated with a successful live generation
- `pnpm` on `PATH` for `dsh plugin` profile management

Claude Code authentication is not needed for deterministic CI. An authenticated
smoke requires a successful live generation; `claude auth status` alone is not
treated as proof of readiness, and the plugin never reads credential files.

## Build and verify

```bash
npm install
npm run check
```

After `claude auth login`, run the production adapter smoke against the host CLI:

```bash
npm run smoke:claude
```

Use `npm run smoke:claude -- --bundled` to exercise the SDK-bundled CLI instead.

Run the reusable prerequisite and transport diagnostic without a model call:

```bash
npm run build
node lib/cli.js doctor --policy host-only --no-live
```

Then run `node lib/cli.js doctor --policy host-only --live` for conclusive
authentication. `claude auth status` alone can be stale. The doctor validates
package/peer versions, the selected executable, bounded process lifecycle, SDK
startup, DSH-only MCP authority, exact generation, and child cleanup without
including prompts, tool payloads, environment values, or raw errors in its
report.

## Install into a DSH profile

For a safe packed-artifact rehearsal against an isolated temporary DSH home:

```bash
npm run test:profile
```

For a local development checkout:

```bash
dsh plugin --profile web add .
dsh --profile web --dump-config
```

Restart the profile after installing. The bundle adds one `llm-claude-code` row
and selects `claude-code/default` through the existing `agent-default-model`
row. Later user/profile patches retain precedence. To remove it:

```bash
dsh plugin --profile web remove dsh-claude-plugin
```

Use the [complete installation and removal guide](docs/install.md) to capture
before/after dumps and prove the profile returns to baseline. Stable doctor,
adapter, and profile-verifier failures are mapped in the
[troubleshooting guide](docs/troubleshooting.md).

The current route supports Standard-style text, image, and DSH tool turns.
Treat it as pre-release until the authenticated tool, replay, and WebUI gates in
the implementation plan pass.

## WebUI end-to-end test

The keyless lane installs the packed checkout into an isolated current-DSH Web
profile and drives the real UI in Chromium:

```bash
npx --no-install playwright install chromium
npm run test:web
```

After `claude auth login`, run `npm run test:web:live` for text, tool,
cancellation, multi-turn, and cold-restart coverage. See the
[WebUI end-to-end guide](docs/web-e2e.md) for the evidence boundary, sanitized
report schema, browser checklist, and exact manual-service commands.

## Direct-Claude parity benchmark

List the versioned scenarios and run the authenticated gate without starting a
benchmark:

```bash
npm run benchmark:list
npm run benchmark
```

After `claude auth login`, `npm run benchmark:live` runs the same fixtures
through the direct Claude Agent SDK and through DSH plus this plugin. The
default one-warm-up/five-measurement design records paired latency,
correctness, tool correlation, usage, and process cleanup while retaining only
sanitized counts and output digests. See the
[benchmark and weakness-evaluation guide](docs/benchmark.md) for scenario
coverage, fairness controls, P0/P1/P2 thresholds, and artifact rules.

## Tool authority and correlation

Only tool names under `mcp__dsh__*` are allowed inside Claude Code. Tool schemas
are copied into the MCP catalog as raw JSON Schema, including nested, union,
enum, and constrained forms. Catalog changes are allowed only between settled
generations.

The bridge requires Claude Code to attach its provider tool-use ID as
`claudecode/toolUseId`. Before DSH receives a tool boundary, the bridge matches
that ID with the streamed call ID, DSH tool name, canonical arguments, and
catalog generation. Missing, duplicate, stale, timed-out, or mismatched data
closes the session with `CLAUDE_TOOL_PROTOCOL_ERROR` or
`CLAUDE_TOOL_TIMEOUT`; it never guesses by name or call order. This metadata is
a pinned Claude Code compatibility seam and must be reverified during upgrades.

## Content, reasoning, and telemetry

Prompt images remain durable DSH attachment references in history. Immediately
before a Claude request, the adapter asks `ctx.attachments` for a verified,
route-sized request variant and converts only that variant to SDK base64. It
does not persist base64, paths, provider URLs, or temporary URLs in replay
state. The adapter applies the tighter of DSH's deployment limits and these
Claude-side bounds:

- 20 images per request;
- 8,000 pixels on either dimension;
- 64 million pixels;
- 10 MiB after base64 encoding.

The same resolver preserves image tool results as MCP image blocks. DSH core
`text` and `image` blocks are supported directly. Merge-extensible tool-result
blocks may also use MCP-compatible `resource`, `resource-link` (or
`resource_link`), `structured { value | data }`, and `error { message }`
shapes. Inline structured/resource extensions are capped at 1 MiB and validated
against the current MCP result schema. Unknown content fails with
`CLAUDE_UNSUPPORTED_INPUT` or `CLAUDE_TOOL_PROTOCOL_ERROR`.

The adapter conservatively advertises `low`, `medium`, and `high` reasoning
effort for stable Claude aliases. It does not advertise `xhigh` or `max`, whose
availability depends on the concrete model behind an alias. Thinking blocks
emitted by Claude are preserved as DSH reasoning blocks; if Claude emits no
thinking, the adapter fabricates none.

DSH's usage chunk has token fields but no cost field. The adapter therefore:

- emits validated disjoint input, output, cache-read, cache-write, and available
  main-loop thinking-token deltas through DSH;
- retains cumulative per-model SDK counters, model/provider facts, and estimated
  USD cost in adapter replay telemetry;
- includes cost deltas and cumulative totals in redacted debug diagnostics.

Claude SDK cost is an estimate, not a billing statement. At an MCP tool pause,
the SDK has not produced its terminal result yet, so accounting for that model
call appears with the next result after DSH returns the tool output. No cost is
invented for DSH surfaces that expose only `TokenUsage`.

With `debug: true`, each generation gets one UUID correlation ID. Diagnostic
records are capped at 4 KiB and contain hashes, counts, timing, stable error
codes, and usage totals. They exclude prompts, system text, raw session IDs,
tool names/arguments/results, attachment bytes, environment values, and error
messages. `debug: false` emits no plugin diagnostic records.

## Configuration

| Field                    | Default     | Meaning                                                       |
| ------------------------ | ----------- | ------------------------------------------------------------- |
| `claudeCommand`          | `claude`    | Bare host executable or absolute path                         |
| `executablePolicy`       | `host-only` | Host/bundled executable selection                             |
| `defaultModel`           | `sonnet`    | Target of the `default` model alias                           |
| `sessionIdleMs`          | 15 minutes  | Evict a settled live Claude query after this idle interval     |
| `toolRoundTripTimeoutMs` | 30 minutes  | Maximum pause awaiting a DSH tool result                      |
| `shutdownGraceMs`        | 5 seconds   | Managed process shutdown grace                                |
| `passEnv`                | `[]`        | Explicit non-sensitive environment names                      |
| `debug`                  | `false`     | Bounded, redacted correlation and telemetry diagnostics       |

The child receives SDK protocol facts, non-secret OS home/identity variables
needed for Claude Code to locate its own authenticated profile, and explicitly
approved `passEnv` names. Sensitive names and all `DSH_*` environment entries
are rejected. Claude native tools, filesystem settings, SDK hooks, plugins,
main-session skills, and ambient MCP servers are disabled; only the in-process
DSH MCP server is configured. DSH remains the execution authority. Claude Code
still enforces any enterprise-managed policy installed by an administrator.

## Design documents

- [Current-source research](docs/research.md)
- [Architecture proposal](docs/proposal.md)
- [Detailed implementation plan](docs/implementation-plan.md)
- [Install and remove safely](docs/install.md)
- [Troubleshooting and stable diagnostics](docs/troubleshooting.md)
- [WebUI end-to-end testing](docs/web-e2e.md)
- [Benchmark and weakness evaluation](docs/benchmark.md)
- [Current benchmark report](reports/benchmark-2026-08-24.md)
- [Authors and provenance](AUTHORS.md)

## License

[MIT](LICENSE)
