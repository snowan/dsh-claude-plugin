# Install, verify, select, and remove

This guide targets `@deepseek-ai/dsh@0.2.0-rc.2` and
`dsh-claude-plugin@0.1.0`. DSH is in developer preview, so do not assume an
unpinned future DSH release has the same profile contract.

## Prerequisites

- Node.js `22.19+` or `24+`;
- `pnpm` on `PATH` because `dsh plugin` forwards package operations to it;
- Claude Code authenticated by running `claude auth login`;
- a successful live `doctor` probe, not only a successful `claude auth status`.

Install or invoke the supported DSH release with npm:

```bash
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 --version
```

## Verify a checkout before installation

From this repository:

```bash
npm ci
npm run check
npm run build
node lib/cli.js doctor --policy host-only --no-live
```

The keyless doctor proves dependency compatibility, executable metadata, SDK
startup, DSH MCP isolation, and child cleanup. After `claude auth login`, run
the conclusive generation probe:

```bash
node lib/cli.js doctor --policy host-only --live
```

`PASS generation.live` means Claude returned the exact diagnostic token. The
command never reads credential files and the report contains no prompt, tool
payload, environment values, or raw provider errors.

## Safe isolated profile rehearsal

The repository gate packs the package, initializes a temporary DSH home,
installs the tarball into its `web` profile, runs the bundled-runtime doctor,
removes the package, and proves the semantic profile tree returned exactly to
baseline:

```bash
npm run test:profile
```

It never touches the normal DSH home. Set `DSH_PROFILE_TEST_BIN` only when
testing a separately installed compatible DSH executable. Add `-- --keep` to
retain the temporary fixture for diagnosis.

## Install into your Web profile

Capture a boot-free baseline before changing the profile:

```bash
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config > /tmp/dsh-before.yml
```

For a local checkout, build a transportable tarball and install that artifact:

```bash
npm ci
npm run check
npm pack
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "$(pwd)/dsh-claude-plugin-0.1.0.tgz"
```

Once the package is published, replace the tarball path with the exact package
version. Do not install from an unpinned moving branch for a production profile.

Capture and verify the installed tree:

```bash
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config > /tmp/dsh-installed.yml
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web exec dsh-claude-plugin verify-profile \
  --before /tmp/dsh-before.yml \
  --installed /tmp/dsh-installed.yml
```

The verifier permits exactly two semantic effects:

1. append `llm-claude-code` with package `dsh-claude-plugin`;
2. change only `agent-default-model.config` to
   `{ provider: claude-code, model: default }`.

Every security, approval, sandbox, tool, session, storage, UI, and unrelated
model row may be formatted differently but must remain semantically identical
and in the same order.

Run the live doctor from the verified checkout. DSH 0.2 resolves its own
packages only inside the `dsh` launcher, so `dsh plugin exec` runs the installed
CLI under plain Node: `verify-profile` works there, but `doctor`, which imports
the DSH packages it probes, reports that it must run from a checkout. The
checkout pins the same Agent SDK as the installed package:

```bash
node lib/cli.js doctor --policy host-only --live
```

## Start and select Claude in WebUI

Stop any older process already listening on the chosen port, then start the
exact pinned DSH command from the intended workspace:

```bash
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web --port 3080 --no-open
```

Open `http://127.0.0.1:3080`, create a Standard agent, and confirm its selected
model is `claude-code/default`. The bundle changes the profile default, so no
DSH source edit is needed. User and profile overlays applied above the bundle
can intentionally select another provider.

Before accepting a result, verify the listener PID, its working directory, the
plugin commit or tarball version, and the effective dump. A page on port 3080
can belong to an older DSH process.

## Remove and prove restoration

Remove the package from the same profile, dump the tree, and compare it with the
captured baseline:

```bash
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web remove dsh-claude-plugin
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config > /tmp/dsh-removed.yml
node lib/cli.js verify-profile \
  --before /tmp/dsh-before.yml \
  --installed /tmp/dsh-installed.yml \
  --removed /tmp/dsh-removed.yml
```

A passing removal report proves the adapter row is gone, the prior default
model row is restored, all unrelated rows match, and ordering is unchanged.

## Profile isolation for experiments

To rehearse manually without the normal profile, point DSH at a fresh temporary
home and isolate compatible shared-agent skills:

```bash
DSH_CLAUDE_TEST_HOME="$(mktemp -d /tmp/dsh-claude-test.XXXXXX)"
export DSH_HOME="$DSH_CLAUDE_TEST_HOME"
export DSH_AGENTS_HOME="$DSH_CLAUDE_TEST_HOME/agents"
```

Run the same baseline/install/verify/remove sequence in that shell. Delete the
temporary directory after inspecting the evidence.
