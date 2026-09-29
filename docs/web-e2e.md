# DSH WebUI end-to-end testing

This suite tests the packed plugin through the public surface of the current
DeepSeek Harness release. It does not reuse a developer's normal DSH home,
fixed port, existing browser tab, or source checkout.

## Evidence levels

| Lane | Requires Claude login | What it proves |
| --- | --- | --- |
| `test:web` | No | Packed install, protected profile rows, doctor startup/MCP/cleanup, Web server boot, real Chromium UI, Claude model discovery/default, invalid-reasoning error, and complete shutdown |
| `test:web:live` | Yes | Everything above plus exact text, same-session memory, a correlated DSH bash tool round trip, cancellation, persisted history, cold restart, and post-restart continuity |

The keyless lane intentionally sends no prompt. A green keyless report is not
evidence that a Claude account is authenticated or that provider generation
works. Only the live lane is conclusive for authentication.

## Run the keyless lane

Install the Chromium revision pinned by the same Playwright version as DSH,
then run the suite:

```bash
npm ci
npx --no-install playwright install chromium
npm run test:web
```

Use `npm run test:web -- --headed` to watch the automated browser. Use
`npm run test:web -- --no-browser` only for local diagnosis; CI deliberately
runs Chromium and treats browser coverage as required.

The runner performs these operations inside one temporary fixture:

1. installs `@deepseek-ai/dsh@0.2.0-rc.2`;
2. packs the exact plugin checkout and records its SHA-256 digest;
3. installs the tarball into an isolated `web` profile;
4. verifies that only `llm-claude-code` and `agent-default-model` changed;
5. runs the checkout doctor without an authenticated generation, because
   `dsh plugin exec` cannot load DSH 0.2 packages;
6. starts DSH on an OS-assigned `127.0.0.1` port and exchanges its launch
   token for the browser-session cookie that every RPC call sends;
7. pins DSH's browser directory picker only for Playwright automation;
8. opens the actual WebUI and adds a disposable workspace next to DSH's
   default workspace;
9. verifies the Claude Code model menu and public RPC state;
10. stops DSH and proves its listener and descendants are gone.

The browser-picker overlay is a test-only input. It replaces DSH's automatic
native folder dialog because Playwright cannot drive a macOS or Linux desktop
chooser. It does not alter model, tool, approval, sandbox, session, or plugin
configuration.

## Run the authenticated lane

First establish Claude Code authentication outside DSH:

```bash
claude auth login
claude auth status
npm run test:web:live
```

The checkout doctor is the lane's first authenticated gate. The Web
server is not started when exact generation fails, so a stale login cannot be
misreported as an application failure. The live scenarios then verify:

- exact text appears in both durable history and the browser;
- a private nonce survives a second turn without entering the report;
- Claude calls the DSH `bash` tool and its correlated result is durable;
- cancellation terminates an active tool turn without a success marker;
- DSH exits with no Claude descendant left alive;
- the same isolated home restarts and reopens prior history;
- a post-restart turn recalls the earlier nonce through the plugin's replay
  path.

Prompts, nonces, tool arguments/results, provider text, server logs, credential
values, environment values, and temporary paths are excluded from reports.

## Browser acceptance checklist

A passing browser scenario asserts all of the following:

- the real application frame has three columns;
- the welcome notice can be acknowledged without a DeepSeek credential step;
- a disposable workspace creates a Standard session;
- the model trigger names `Claude Sonnet (default)`;
- the Claude Code group contains `default`, `sonnet`, `opus`, and `haiku`;
- the public session route is `claude-code/default` and is routable;
- reasoning choices are `low`, `medium`, and `high`;
- no `Failed to load plugins` state, page error, or console error appears;
- the final screenshot comes from the same isolated process described by the
  report.

## Artifacts and failure diagnosis

The default files are gitignored:

```text
.artifacts/web-e2e-keyless.json
.artifacts/web-e2e-keyless.png
.artifacts/web-e2e-live.json
.artifacts/web-e2e-live.png
```

Every JSON report has schema version 1 and includes the plugin commit/branch,
dirty bit, DSH/Node/Playwright versions, packed-artifact digest, scenario
statuses and durations, bounded payload-free history counts, and cleanup
evidence. CI uploads the keyless report and screenshot even on failure.

For a local failure, rerun with bounded developer diagnostics and optionally
retain only the isolated fixture:

```bash
DSH_WEB_E2E_DEBUG=1 npm run test:web -- --keep
```

Debug output may include local paths or upstream error text and must not be
copied into a public issue without review. The JSON report remains sanitized.

Set `DSH_WEB_TEST_BIN` to an existing executable only when it reports exactly
DSH `0.2.0-rc.2`; the runner refuses version drift.

## Start a manual local WebUI from this checkout

Use a fresh shell and isolated home so an existing service on port 3080 cannot
be mistaken for this build:

```bash
npm ci
npm run check
npm pack
DSH_CLAUDE_WEB_HOME="$(mktemp -d /tmp/dsh-claude-web.XXXXXX)"
export DSH_HOME="$DSH_CLAUDE_WEB_HOME/dsh"
export DSH_AGENTS_HOME="$DSH_CLAUDE_WEB_HOME/agents"
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "$(pwd)/dsh-claude-plugin-0.1.0.tgz"
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web --host 127.0.0.1 --port 3080 --no-open
```

Before opening `http://127.0.0.1:3080`, verify that the listener PID belongs
to the last command and that its cwd is the intended test workspace. Stop that
exact process when finished; remove the temporary home only after it exits.
