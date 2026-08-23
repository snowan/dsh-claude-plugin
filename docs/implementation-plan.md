# Detailed implementation plan

This plan converts the accepted architecture into small, ordered pull requests.
One PR owns one coherent task. A PR is tested at its exact head, records its
results in the PR description, and merges before the dependent branch starts.

## Delivery rules

- Branches start from the current remote `main` and use the `michi/` prefix.
- Stage explicit paths; never stage the whole worktree implicitly.
- Do not mix refactors, dependency upgrades, and behavior changes.
- No copied source, imported Git history, or `Co-authored-by` trailers.
- Unit/contract checks must be keyless and deterministic.
- Authenticated tests must identify exact DSH, SDK, CLI, OS, commit, and model.
- A failing hosted check, missing test result, unresolved review, or dirty exact
  head blocks merge.
- Newly discovered defects receive their own follow-up fix PR.

## PR 1 — Research, proposal, and implementation plan

Branch: `michi/proposal`

### Deliverables

- `docs/research.md`
- `docs/proposal.md`
- `docs/implementation-plan.md`
- `AUTHORS.md`
- README links and current status

### Verification

- Markdown formatting/lint.
- Local relative links resolve.
- External sources use primary DSH/Anthropic references where available.
- `git diff --check` is clean.
- `git shortlog -sne --all` contains only snowan.
- No implementation source is introduced.

### Exit criteria

Architecture, security boundary, PR ordering, tests, acceptance criteria, and
independent provenance are decision-complete and reviewed.

## PR 2 — Package scaffold and DSH registration

Branch: `michi/adapter-scaffold`

### Deliverables

- ESM TypeScript package with Node 22 baseline.
- `package.json` exports, files, scripts, peer/dev dependencies, and `dsh.bundle`.
- `tsconfig.json`, build config, Vitest config, lint/format config.
- `src/index.ts`, `src/models.ts`, `src/errors.ts`.
- `cordis.patch.yml` inserting the `claude-code` adapter and narrowly patching
  the default route.
- Initial README install/configuration section.
- CI workflow for build, lint, typecheck, tests, package dry-run, and authorship.

### Public behavior

- Cordis loads the plugin only after `llm` and `subprocess` exist.
- `ctx.llm` lists `claude-code/default`, `sonnet`, `opus`, and `haiku`.
- Configuration validates synchronously with actionable errors.
- `stream()` returns a deliberate not-yet-implemented adapter failure rather
  than hanging or accidentally calling a network API.

### Tests

- Config defaults/bounds/table tests.
- Model alias and explicit-name resolution tests.
- Cordis registration/disposal test.
- Loader composition test against DSH `0.1.1-rc.2`.
- Bundle manifest and patch snapshot.
- `npm pack --dry-run` contains only intended files.

### Exit criteria

The installed bundle is discoverable and reversible, does not replace security
rows, and the WebUI can list the provider even though generation is gated.

## PR 3 — Managed Claude SDK transport and streaming output

Branch: `michi/sdk-streaming`

### Deliverables

- `src/process.ts` resolves the configured host CLI and supplies the SDK custom
  spawn hook through `ctx.subprocess`, with an original Node-like
  `SpawnedProcess` wrapper and explicit environment filtering.
- `src/bridge.ts` creates one serialized streaming query and one persistent
  background event pump per DSH session.
- `src/input.ts` translates admitted user content for live continuation without
  pretending arbitrary assistant history is accepted by the SDK.
- `src/output.ts` treats partial stream events as delta authority and completed
  messages as structural reconciliation.
- `src/usage.ts` snapshots cumulative per-model counters and emits validated
  per-step input/output/cache deltas without double-counting.
- Injectable SDK/query factory for deterministic tests.

### Tests

- Fake query fixtures for fragmented text and thinking deltas.
- Block ordering and exactly-one-finish property tests.
- Cumulative multi-turn usage fixtures, missing optional counters, session epoch
  reset, and negative-delta rejection.
- Executable resolution, environment allowlist, spawn args, exit, and stderr
  truncation tests.
- Per-session isolation and same-session serialization tests.
- Abort before output, during output, and after result tests.
- Real local keyless process fixture driven through `ctx.subprocess`.

### Authenticated smoke

Run a text-only prompt through the adapter with the authenticated host CLI and
record streaming output, finish reason, usage, latency, versions, and cleanup.

### Exit criteria

DSH can complete a real text-only Claude turn with live streaming and no orphan
process. No tool is exposed yet.

## PR 4 — DSH-owned MCP tool pause/resume bridge

Branch: `michi/tool-bridge`

### Deliverables

- `src/tool-server.ts` exposes the immutable request tool catalog through a
  low-level in-process MCP server using raw DSH JSON Schema.
- `src/pending-tools.ts` owns pending call correlation and timeouts.
- Output translation emits DSH tool-call chunks and ends that DSH step with
  `finish(tool-calls)`.
- The persistent pump parks at unresolved MCP handlers; the next `stream()`
  consumes exact DSH tool-result messages, resolves those handlers, and drains
  continued output from the same Claude query.
- Native Claude tools/settings/plugins/hooks/skills/MCP are disabled.

### Tests

- MCP list/call contract with simple, nested, union, enum, and constrained DSH
  JSON Schemas.
- One tool success, one tool error, multi-tool, mixed results, and out-of-order
  DSH completion.
- Duplicate, unknown, missing, stale-generation, mismatched-name, and timed-out
  IDs fail closed.
- Tool catalog is immutable during one generation and replaceable between
  generations.
- Built-in Claude tools are absent; only `mcp__dsh__*` is allowed.
- Cancellation rejects MCP waiters and cleans the query/process.

### Authenticated E2E

Ask Claude to read a known fixture through the real DSH `read` tool, verify the
tool row and result in the session log/Web API, then verify Claude's final answer
contains the fixture value. Repeat with an approved shell command and a denied
tool call.

### Exit criteria

There is one tool execution in DSH, no native duplicate, and the same Claude
turn resumes to completion.

## PR 5 — Session lifecycle, cold replay, and recovery

Branch: `michi/session-lifecycle`

### Deliverables

- `BridgeManager` idle eviction and plugin-wide disposal.
- Generation state machine preventing concurrent protocol mutation.
- Versioned replay state with consumed-prefix fingerprint, Claude session/fork
  identifiers, model, and cumulative usage snapshot.
- Exact resume only for a matching prefix and safe Claude transcript identifier.
- Canonical length-bounded degraded transcript envelope for divergent history.
- `COLD_REPLAY_UNSUPPORTED` and explicit unsupported in-flight recovery.
- Model changes between generations.
- Typed cancellation, CLI exit, malformed event, and timeout recovery.
- Retry gate that permits only pre-observable failures.

### Tests

- Multi-turn context continuity and session isolation.
- Idle eviction and deterministic fake-clock cleanup.
- Exact cold resume from matching text/tool/error history without duplicate
  output.
- DSH fork uses a safe stored fork point when available.
- Divergent/compacted/imported history forces a canonical degraded replay;
  oversized or unrepresentable history fails closed.
- Contract probe proves assistant-role SDK input is rejected and never used as
  the reconstruction mechanism.
- Crash with pending tool fails explicitly; next clean request recovers.
- Model change while idle versus during generation.
- Process tree is gone after every terminal path.

### Authenticated E2E

Complete a two-turn memory scenario, restart the plugin/DSH process, and verify
the third turn reconstructs the agreed fact exactly once.

### Exit criteria

Session reuse improves latency without becoming a second unverified source of
durable truth.

## PR 6 — Content and telemetry fidelity

Branch: `michi/content-fidelity`

### Deliverables

- DSH text/image input conversion to SDK message blocks.
- MCP text/image/resource/resource-link/structured/error result conversion.
- Thinking/reasoning preservation where SDK policy exposes it.
- Full usage/cost metadata mapping with documented unavailable fields.
- Bounded redacted debug diagnostics and per-generation correlation IDs.

### Tests

- PNG/JPEG/WebP/GIF input and output fixtures.
- Mixed text/image messages.
- Structured content and resource link fixtures.
- Oversized/unsupported MIME failure behavior.
- Reasoning enabled/disabled fixtures.
- Log redaction tests for prompts, credentials, environment values, and tool
  payloads.
- Usage invariants against recorded SDK result shapes.

### Exit criteria

Supported rich content is preserved end to end; unsupported content fails with
an actionable error instead of being dropped.

## PR 7 — Doctor, installation, and profile safety

Branch: `michi/doctor-install`

### Deliverables

- `dsh-claude-plugin doctor` CLI and reusable doctor API.
- Checks for package compatibility, executable, version, auth metadata, spawn
  lifecycle, SDK startup, MCP handshake, and conclusive authenticated live
  generation.
- Installation/removal and model-selection guide.
- Troubleshooting guide keyed by stable error codes.
- Profile dump verifier proving only intended rows change.

### Tests

- Doctor success/failure snapshots using fake CLI executables.
- Logged-out, stale logged-in metadata with expired token, missing, old,
  crashing, and slow executable cases.
- DSH `plugin add`/`plugin remove` against isolated temporary profiles.
- Before/after config dump structural diff.
- Profile security/tool/session/UI rows remain identical.
- Package tarball install in a clean fixture project.

### Exit criteria

A user can diagnose prerequisites, install, select Claude, and remove the plugin
without editing DSH source or weakening policy.

## PR 8 — Current DSH WebUI end-to-end suite

Branch: `michi/dsh-web-e2e`

### Deliverables

- Reproducible local integration harness pinned to the current DSH release.
- Web/API test scenarios for model discovery, text, tool, error, cancellation,
  multi-turn, and restart.
- Browser acceptance checklist and sanitized evidence report.
- Exact commands for starting DSH with the local plugin.

### Tests

- Start an isolated DSH Web profile on an available verified port.
- Verify PID, cwd, branch, commit, loaded config, and selected provider.
- Exercise all scenarios via DSH's public Web/RPC surface.
- Inspect browser-visible stream/tool/error state.
- Stop DSH and prove no child process or stale listener remains.
- Repeat the deterministic subset in CI without Claude credentials.

### Exit criteria

The exact plugin head works in the actual DSH WebUI—not only a unit harness or
stale local listener.

## PR 9 — Direct-Claude parity benchmark and weakness report

Branch: `michi/benchmarks`

### Deliverables

- `bench/` runner executing equivalent scenarios through direct Claude Code and
  DSH+plugin.
- Machine-readable JSONL results and reproducible task fixtures.
- `reports/benchmark-<date>.md` with methodology, environment, raw references,
  statistical summary, weaknesses, and prioritized remediation.
- P0/P1/P2 severity rubric and regression thresholds.

### Scenario matrix

| Category | Scenario |
| --- | --- |
| Text | short answer, long stream, Unicode, structured reasoning |
| Repository | inspect files and explain a dependency flow |
| Tools | read, search, shell, edit in disposable fixture |
| Multi-tool | parallel reads and mixed success/error |
| Session | three-turn fact continuity and cold restart |
| Safety | denied destructive command and unavailable path |
| Reliability | CLI crash, malformed event, tool timeout, cancellation |
| Content | image input and image tool result |

### Metrics

- scenario success and semantic correctness;
- first-token latency;
- tool-request latency;
- end-to-end latency;
- input/output/cache tokens and reported cost;
- process count and cleanup time;
- duplicate/missing stream blocks;
- tool ID/result fidelity;
- direct-versus-plugin answer divergence.

Run warm-up plus at least five measured repetitions for deterministic latency
scenarios. Report median, p95, range, and failures; do not compare one cherry-
picked run.

### P0 gates

Any of the following blocks completion and requires a separate fix PR:

- tool executes twice or outside DSH policy;
- result is delivered to the wrong call/session;
- cancellation leaves a child process or unresolved generation;
- credentials/prompt/tool content appears in default logs;
- DSH transcript and Claude context silently diverge;
- plugin cannot install/remove cleanly on the supported DSH release;
- authenticated baseline succeeds directly but consistently fails through the
  plugin for a core text/read/shell scenario.

### Exit criteria

The report names measured weaknesses and links each accepted P0/P1 remediation
to its own issue/PR. Completion waits for every P0 fix to merge and its scenario
to pass again.

## Final release-readiness audit

After all planned and benchmark-driven fix PRs merge, verify at exact remote
`main`:

1. Clean checkout and dependency install.
2. Build, format, lint, typecheck, unit, contract, loader, keyless E2E, package
   dry-run, and authorship checks.
3. Authenticated Claude text/tool/session/restart scenarios.
4. DSH WebUI model selection and visible tool lifecycle.
5. Direct-versus-plugin benchmark report with no open P0.
6. README installation/removal commands reproduced from a clean profile.
7. No DSH source modification and no ambient profile security changes.
8. `git shortlog -sne --all` contains only snowan.
9. GitHub contributors API contains only snowan.
10. Every implementation/fix task is traceable to one merged, tested PR.

Only this audit can establish that the objective is complete.
