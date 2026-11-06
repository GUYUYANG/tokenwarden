# Architecture

TokenWarden is intentionally small. It separates what is portable from what is host-specific.

```text
portable core
├── structured telemetry reader
├── bounded task ledger
├── deterministic decision rules
└── privacy boundary

host adapters
├── Codex: hooks.json + rollout JSONL
└── DSH: Cordis plugin events
```

## Cost model

The project starts with an observable model rather than a guess:

```text
work ≈ model calls × active context
```

Changing the model price multiplies both terms. The audit therefore reports:

- model calls;
- input, cached input, and output tokens;
- context samples above a configurable threshold;
- repeated tool calls and repeated output size;
- compaction frequency;
- command and tool-call counts before the first mutation;
- a counterfactual excess-input estimate only when pricing is known.

The counterfactual estimate is not a savings guarantee. It indicates where replay pressure exists.

## Task ledger

The task-memory adapter reads structured transcript records and maintains a compact ledger with:

- task type and goal;
- user statements and confirmed facts;
- assistant hypotheses, including rejected state;
- pending acceptance checks;
- touched files;
- structured verification events;
- latest assistant conclusion and whether it was later contradicted;
- repeated-failure count;
- a byte cursor for incremental reads.

Each event updates the ledger atomically. The model receives a bounded text rendering, never the raw transcript.

Injection is selective:

| Event | Inject? | Reason |
| --- | --- | --- |
| `SessionStart(source=compact)` | Work sessions only | Restore facts after a summary boundary |
| Correction or complaint | Yes | Prevent a rejected assumption from returning |
| Explicit continuation | Yes | Reuse the active task state |
| Standalone lookup in a work session | No | Avoid polluting an unrelated query |
| Query-only session | No, unless it becomes work | Queries do not carry debugging state |

The current-turn user message has higher priority than historical assistant statements. A rejected hypothesis remains disabled until new evidence is observed.

## Failure circuit breaker

Complaints and repeated failed acceptance checks increment a loop counter. Once the count reaches two:

1. the next step must state a falsifiable hypothesis;
2. the hypothesis must be checked against new runtime evidence;
3. another similar patch is no longer acceptable without that evidence;
4. if no evidence path exists, the task should be reported as blocked.

This is a context rule, not a semantic judge. It cannot prove that two patches are different; it prevents the system from silently forgetting that the previous path failed.

## Model-switch guard

The model-switch guard restores the previous model from local state and structured transcript metadata. It compares known model prices and current context size before the first prompt after a switch.

Decision bands:

- below the context threshold: no action;
- cheaper or similarly priced model: no action;
- more expensive model with a bounded first-call estimate: inject a compact execution plan;
- first-call estimate above the configured cap: block once and recommend compaction or a handoff.

If either model has no known price, the guard does nothing. It degrades open rather than guessing.

## Storage

```text
~/.codex/tokenwarden/
├── model-switch-state.json
├── model-switch-events.jsonl
└── task-memory/
    ├── <session-id>.json
    └── events.jsonl
```

State files use atomic rename. Event logs contain decisions and counters, not prompts, responses, reasoning, or raw tool output.

## Extending to another host

An adapter needs:

1. a read-only transcript or event source with model and usage metadata;
2. a way to inject bounded context before a turn;
3. a session identifier;
4. a compaction or checkpoint signal;
5. an explicit trust model for local command execution.

The ledger and audit logic can be reused. Event names, installation, and trust prompts cannot be assumed across hosts.
