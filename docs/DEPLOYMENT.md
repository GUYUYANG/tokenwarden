# Deployment

## Prerequisites

- Node.js 22.15 or newer.
- A local Codex installation with user Hooks enabled.
- A readable Codex session directory, normally `~/.codex/sessions`.

TokenWarden has no runtime package dependencies and does not require a build.

## Install

```bash
git clone https://github.com/GUYUYANG/tokenwarden.git
cd tokenwarden
npm run verify

node tools/install-codex-task-memory.mjs
node tools/install-codex-model-switch-guard.mjs
```

The installers:

- parse the existing `~/.codex/hooks.json`;
- preserve unrelated Hook groups;
- remove only an older copy of the same TokenWarden Hook;
- write through a temporary file and atomic rename;
- create a timestamped backup before replacing an existing file.

After installation, open `/hooks` in Codex and review the exact commands. Trust the Hooks only after inspection. Start a new session so the changed configuration can load.

## Verify

1. Run the local test suite:

   ```bash
   npm run verify
   ```

2. Run a read-only audit on a small session:

   ```bash
   node tools/codex-session-audit.mjs <session-id> --threshold 200000
   ```

3. Open a new session, submit a work request, and confirm the Hook appears as trusted.
4. Trigger a real context compaction in a disposable session and confirm the task-memory event log contains an injection.

The first four checks validate installation and bounded behavior. The real compaction event is the only proof that the `SessionStart(source=compact)` path ran in your host.

## Configuration

All configuration is through environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex configuration and session root |
| `TOKENWARDEN_TASK_MEMORY` | enabled | Set to `0`, `false`, `off`, or `no` to disable task memory |
| `TOKENWARDEN_TASK_MEMORY_DIR` | `~/.codex/tokenwarden/task-memory` | Override task-ledger storage |
| `TOKENWARDEN_TASK_MEMORY_MAX_CHARS` | `2200` | Maximum injected memory length |
| `TOKENWARDEN_MODEL_SWITCH` | enabled | Disable the model-switch guard with a false-like value |
| `TOKENWARDEN_MODEL_SWITCH_MIN_CONTEXT` | `80000` | Minimum context before model-switch evaluation |
| `TOKENWARDEN_MODEL_SWITCH_BLOCK_CNY` | `0.5` | Estimated first-call input cap |
| `TOKENWARDEN_COST_METER_COMMAND` | `codex-cost-meter` | Optional local pricing CLI command |

The earlier `TOKEN_GUARD_*` names remain supported as aliases for migration compatibility.

If `codex-cost-meter` is unavailable, TokenWarden uses its small built-in price table for known DeepSeek models. Unknown models remain unpriced and are not blocked.

## Uninstall

```bash
node tools/uninstall-codex-hooks.mjs
```

This removes only commands containing `codex-task-memory.mjs` or `codex-model-switch-guard.mjs`. It preserves unrelated Hooks and creates a backup before writing.

Local state is intentionally not deleted automatically:

```text
~/.codex/tokenwarden/
```

Review and remove that directory only if you no longer need the ledger or event history.

## DSH adapter

`adapters/dsh/` contains the original Cordis host adapter. It demonstrates:

- tool-description reduction;
- historical reasoning filtering;
- a per-turn estimate cap;
- balance gating;
- a host-side compaction fallback.

This adapter is host-specific and should be installed through the DSH plugin bundle mechanism. Its event names and service lookups are not part of the portable core. Do not treat Codex Hook instructions as DSH installation instructions, or vice versa.

## Compatibility

| Surface | Status |
| --- | --- |
| Node.js 22.15+ | Required |
| macOS local Codex Hooks | Runtime-tested by the maintainer |
| Linux Node environment | Covered by CI |
| Windows | Not runtime-verified |
| Codex rollout JSONL | Supported |
| Codex `.jsonl.zst` audit | Requires Node.js with Zstandard support |
| DSH adapter | Host-specific / experimental |

The deployment remains local-first. No third-party service is contacted by the audit or task-memory code. Optional pricing calls only execute the configured local CLI.
