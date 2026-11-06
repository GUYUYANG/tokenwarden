# Security and privacy

## Threat model

TokenWarden runs local code with the permissions of the current user. It reads local session metadata and may inject text into an AI-agent session. A malicious local modification to the repository or `hooks.json` can execute arbitrary commands.

Mitigations:

- no runtime dependencies;
- no telemetry or analytics;
- installers preserve unrelated Hooks;
- installers back up `hooks.json`;
- Hook commands can be reviewed before trust;
- an uninstaller removes only TokenWarden markers.

## Local data

Task-ledger state is stored under:

```text
~/.codex/tokenwarden/
```

The task ledger may contain concise user statements, acceptance criteria, file paths, and verification summaries. It is intended to be sensitive local data. It is not encrypted.

The model-switch log records model names, context size, estimated cost, actions, and timestamps. It does not record prompt or transcript text.

## Sharing audit output

The read-only audit does not print prompts, assistant messages, reasoning blocks, tool arguments, or raw tool output. Its JSON can still contain:

- session ID;
- working directory;
- session file path;
- model and provider names;
- tool names and counts.

Review and redact these fields before attaching an audit to a public issue.

## Reporting a vulnerability

Do not include a full session transcript in a public issue. Open a minimal private security report through the repository's GitHub Security tab when available, or contact the maintainer with:

1. affected version or commit;
2. a minimal synthetic reproduction;
3. expected and observed behavior;
4. whether local files, hooks, or credentials are at risk.
