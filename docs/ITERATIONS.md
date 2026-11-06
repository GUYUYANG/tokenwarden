# Iteration principles

This file records general engineering decisions, not user tasks or session content.

| Version | Change | Reason |
| --- | --- | --- |
| v0 | Observe token usage and cap an expensive turn | A budget without telemetry cannot explain itself |
| v1 | Add structured audit and model-switch checks | Measure where replay pressure enters before changing context |
| v2 | Split host integration from portable rules | Host event names and trust models change independently |
| v0.1 public preview | Add durable task memory and a repeated-failure breaker | Summaries preserve text but can lose confirmed facts and rejected hypotheses |

## Recurring principles

1. Optimize the multiplier with the strongest evidence, not the most impressive-sounding mechanism.
2. Treat a user correction as a state transition, not as another paragraph in a summary.
3. Keep source-of-truth facts separate from generated summaries.
4. After repeated failure, change the hypothesis or collect new evidence before changing code again.
5. Keep injection conditional; unrelated lookups should not inherit debugging state.
6. Store structured counters and bounded summaries when full history is not required.
7. Make unknown states explicit and fail open when safety depends on missing telemetry.
