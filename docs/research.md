# Research: DSH as a primary Claude Code harness

Status: current-source review, 2026-08-23

DSH source snapshot: [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)

## Research question

Can DeepSeek Harness use Claude Code as its primary model route while retaining
DSH's agent loop, tools, permissions, persistence, and WebUI?

Yes. DSH exposes its model boundary as an `LlmAdapter`, while the Claude Agent
SDK exposes Claude Code as a programmable, long-lived query backed by the
Claude Code executable. The missing component is an adapter that translates
between those two protocols and makes DSH—not Claude Code's native tool
runtime—the authority for tool execution.

## Verified compatibility baseline

The versions below were checked from the local executables and npm registry on
2026-08-23. They are a development baseline, not permanent pins.

| Component | Verified version | Role |
| --- | ---: | --- |
| DeepSeek Harness | `0.1.1-rc.2` | Host application and plugin contracts |
| `@deepseek-ai/dsh-llm` | `0.1.1-rc.2` (`next`) | LLM adapter service |
| `@deepseek-ai/dsh-subprocess` | `0.1.1-rc.2` (`next`) | Managed child processes |
| Claude Code host CLI | `2.1.181` | Local executable; live probe found expired OAuth |
| `@anthropic-ai/claude-code` | `2.1.241` | SDK-bundled CLI fallback |
| `@anthropic-ai/claude-agent-sdk` | `0.3.241` | Programmatic Claude Code API |

The installed Claude CLI reported `claude.ai` login metadata, but an isolated
SDK generation returned `401 OAuth access token has expired`. This proves that
`claude auth status` is useful metadata, not a sufficient readiness check. A
live generation probe is required before claiming authenticated E2E success.
The plugin must never read or copy Claude credential files; it asks the
executable/SDK to use the host's existing authenticated session.

## How DSH plugins compose

DSH is a Cordis plugin tree. A TypeScript plugin exports `apply(ctx, config)` and
declares required services through `inject`. Registration through `ctx` is an
effect and is automatically unwound when the plugin unloads.

A profile is an ordered stack of bundles plus user patch layers. An installable
bundle declares its patch in `package.json`:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

The bundle patch inserts the adapter row and can patch the default model route.
Users retain final control because profile and home-level patches apply above
the bundle. The effective tree is inspectable with:

```bash
dsh --profile web --dump-config
```

The package is installed into one profile with:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-claude-plugin
```

Sources:

- [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DSH first-plugin guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)
- [DSH app boot and bundle contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md)

## The primary model seam

DSH's `LlmAdapter` contract is the correct extension point. An adapter:

1. exposes `providerInfo`;
2. lists and resolves models;
3. implements `stream(options)` as an `AsyncIterable<StreamChunk>`;
4. registers on `ctx.llm` under a provider ID.

`GenerateOptions` supplies provider/model selection, system prompt, projected
messages, DSH tool schemas, cancellation, session ID, and request purpose. The
adapter returns ordered chunks for text, reasoning, tool calls, usage, and one
terminal finish reason.

This is materially different from DSH's existing
`@deepseek-ai/dsh-subagent-claude-code`. That package registers a one-shot
provider on `ctx.subagents`; it delegates a child task to Claude Code but does
not replace the parent session's model route. It is useful interface evidence,
not a base for this implementation.

Sources:

- [DSH LLM package](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm)
- [DSH Claude Code subagent package](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-claude-code)

## Claude Code integration options

### Option A: parse `claude -p --output-format stream-json`

The CLI supports newline-delimited streaming events, partial message events,
streaming JSON input, session resumption, model selection, MCP configuration,
and strict MCP isolation. This is viable but makes the plugin own an evolving
wire parser and stdin/stdout lifecycle directly.

### Option B: use the official Agent SDK

The Agent SDK drives the same Claude Code product and executable, but provides
typed messages, a long-lived `Query`, cancellation, model changes, streaming
input, in-process MCP servers, and a supported custom process-spawn hook.

Streaming input is the recommended SDK mode. It supports queued messages,
interruptions, images, custom tools, and persistent context. The SDK can be
given an absolute host executable path, while its process spawn is routed
through DSH's managed subprocess service.

### Decision

Use the Agent SDK as the transport and the host `claude` executable as the
default runtime. Keep a configurable SDK-bundled executable fallback for
portable test environments. A compatibility test exercises raw CLI
`stream-json` only as an external baseline; production code does not maintain a
second parser.

Sources:

- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

## The tool-ownership problem

Running Claude Code with its normal built-in tools would bypass DSH's approval,
sandbox, session event, and WebUI tool pipeline. Simply forwarding DSH messages
to `claude -p` is therefore not a correct primary adapter.

The adapter must expose DSH's current tool catalog to Claude as an in-process
MCP server while disabling Claude's built-in tools:

```text
Claude proposes mcp__dsh__read
  -> adapter records the pending MCP request
  -> adapter emits DSH tool-call stream chunks
  -> DSH executes read through its guarded tool pipeline
  -> next adapter step receives the durable DSH tool result
  -> adapter resolves the waiting MCP call
  -> the same Claude query continues
```

This pause/resume bridge ensures there is one execution authority and one
durable tool record. The SDK officially supports in-process MCP servers,
wildcard pre-approval, rich result blocks, and `tools: []` to remove native
built-ins while leaving MCP tools available.

Source: [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)

## Live protocol probes

Small throwaway programs against Agent SDK `0.3.241` established constraints
that are not obvious from the high-level examples:

- Streaming input rejected an embedded assistant-role history message with
  `Expected message role 'user', got 'assistant'`. A cold bridge therefore
  cannot recreate arbitrary DSH history by feeding role-preserving SDK input.
- `claude auth status` reported a logged-in first-party session immediately
  before a minimal isolated query failed with an expired-token `401`. Doctor
  must distinguish account metadata from a successful live generation.
- Result `modelUsage` is cumulative across turns in a streaming-input session.
  The adapter must store the previous snapshot and emit only validated,
  non-negative per-step deltas.
- The SDK custom process hook expects a Node-like `SpawnedProcess`, while DSH
  exposes a `SubprocessHandle`. The plugin needs an original wrapper that maps
  streams, exit events, state, and `kill()` onto DSH's managed lifecycle.

The isolated query used `tools: []`, empty setting sources, no skills or
plugins, and strict MCP configuration. This avoided ambient Claude hooks and
skills observed in a raw host-CLI probe. No credential content was inspected.

## Security conclusions

The secure default is a DSH-owned runtime:

- `tools: []` removes Claude native tools;
- only `mcp__dsh__*` is pre-approved;
- `strictMcpConfig` prevents ambient MCP servers;
- filesystem settings, Claude plugins, hooks, and skills are not loaded;
- interactive permission callbacks fail closed;
- DSH controls cwd, environment filtering, cancellation, and process cleanup;
- credential contents never cross the adapter boundary;
- tool execution remains in DSH's policy and durable event pipeline.

An optional future native-Claude mode would be a different trust model and is
explicitly outside the first stable release.

## Existing-project review and independence boundary

Searches found projects that either import Claude plugin artifacts into DSH or
bridge another coding CLI into DSH. They demonstrate demand and useful failure
modes, but neither is used as source:

- DSH's bundled Claude integration is a subagent, not a primary LLM adapter.
- [`dsh-claude-plugin-loader`](https://github.com/lengdanran/dsh-claude-plugin-loader)
  imports Claude skills/commands/hooks into DSH and states that it mirrors
  monorepo code; it is not an installable primary route.
- A Codex adapter can demonstrate the general pause/resume requirement, but its
  app-server protocol and implementation are not copied.

The implementation in this repository begins with empty source directories and
is derived only from public contracts, observed protocol behavior, and tests
written for this repository. See [Authors and provenance](../AUTHORS.md).

## Open questions to resolve in implementation

1. What bounded timeout policy preserves long human approvals without leaving
   abandoned MCP handlers forever?
2. Which Claude session/fork identifiers remain safe to resume after a DSH
   restart when the stored DSH-prefix fingerprint still matches?
3. What size and content limits make degraded transcript-envelope replay
   explicit and deterministic after compaction, import, or divergent history?
4. Which adjacent Agent SDK versions preserve the probed partial-message,
   cumulative-usage, raw-MCP, and custom-spawn contracts?

Each question has a contract test and an explicit fail-closed fallback in the
implementation plan.
