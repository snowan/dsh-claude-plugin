# dsh-claude-plugin

A from-scratch DeepSeek Harness adapter for running Claude Code as the primary
LLM route while preserving DSH's agent loop, tools, permissions, sessions, and
WebUI.

The design and implementation are being developed in small, independently
tested pull requests. No source code is copied from another plugin or project.

Developed by [snowan](https://github.com/snowan) with Codex assistance.

## Status

The package scaffold registers the `claude-code` provider and its model aliases.
Generation currently returns the deliberate `CLAUDE_TRANSPORT_NOT_IMPLEMENTED`
failure until the managed Agent SDK transport lands in the next milestone.

## Requirements

- Node.js `22.19+` or `24+`
- DeepSeek Harness `0.1.1-rc.2`
- `pnpm` on `PATH` for `dsh plugin` profile management

Claude Code authentication is not needed for the keyless scaffold checks. The
later authenticated E2E suite will require a successful live Claude generation;
`claude auth status` alone is not treated as proof of readiness.

## Build and verify

```bash
npm install
npm run check
```

## Install into a DSH profile

From this checkout:

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

Do not use this scaffold branch as a working model route yet: its stream entry
point is intentionally gated until transport tests pass.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `claudeCommand` | `claude` | Bare host executable or absolute path |
| `executablePolicy` | `host-only` | Host/bundled executable selection |
| `defaultModel` | `sonnet` | Target of the `default` model alias |
| `sessionIdleMs` | 15 minutes | Future live bridge idle lifetime |
| `toolRoundTripTimeoutMs` | 30 minutes | Future DSH tool pause bound |
| `shutdownGraceMs` | 5 seconds | Future managed process shutdown grace |
| `passEnv` | `[]` | Explicit non-sensitive environment names |
| `debug` | `false` | Safe transport diagnostics |

Sensitive names and all `DSH_*` environment entries are rejected from
`passEnv`.

## Design documents

- [Current-source research](docs/research.md)
- [Architecture proposal](docs/proposal.md)
- [Detailed implementation plan](docs/implementation-plan.md)
- [Authors and provenance](AUTHORS.md)

## License

[MIT](LICENSE)
