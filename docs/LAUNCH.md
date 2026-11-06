# Launch playbook

The project should spread through a reproducible artifact, not through claims that it makes an agent “smarter.”

## Positioning

Primary line:

> Long agent sessions do not only fail because the model is weak. They fail because every step carries stale context and every retry can forget what was already ruled out.

Secondary line:

> TokenWarden makes agent cost and loop waste visible, then keeps only the facts that must survive a long session.

Avoid:

- promising a universal percentage reduction;
- claiming that an agent will never repeat a bug;
- presenting synthetic or local measurements as benchmarks;
- leading with implementation details before showing the user-visible problem.

## 60-second proof

1. Show a redacted audit containing context replay, repeated tool calls, or simple-query overhead.
2. Show the calculator: `calls × active context × price`.
3. Show one compact task-ledger injection.
4. Show that an unrelated lookup does not receive the ledger.
5. Show the uninstall command.

## Launch sequence

### Day 0: publish a usable first release

- Tag `v0.1.0`.
- Keep CI green.
- Pin one issue asking users for a redacted audit pattern.
- Include one short GIF or terminal recording when available.

### Day 1: technical communities

Suggested title:

> Show HN: TokenWarden – find and reduce context waste in AI coding agents

Suggested body:

> I kept seeing long coding sessions become slow and expensive even after compaction. The transcript usually shows two different things: replay of context the next step no longer needs, and repeated attempts around a hypothesis the user already rejected. TokenWarden is a local-first audit plus task ledger. It does not call another model. The repo includes the audit, selective memory injection, loop breaker, and uninstall path. I would especially value feedback from people who have large local Codex or agent transcripts.

Chinese community version:

> 做了个本地工具 TokenWarden（词元卫士），不靠第二个模型“监督”第一个模型，而是用结构化遥测找出长会话里的上下文回放和重复修复循环。它会保留用户已确认事实、已否定假设和未完成验收，压缩后只恢复这部分。附带只读审计器、Codex Hook、DSH 适配器、测试和一键卸载。欢迎大家拿真实的脱敏会话打脸。

### Day 2: show evidence

Publish a redacted before/after analysis:

- what the audit measured;
- which finding was actionable;
- what rule changed;
- what remained uncertain;
- the exact reproduction command.

Do not aggregate unrelated test passes into an impact claim.

### Week 1: make contribution easy

- Label adapter and audit-pattern issues as `help wanted`.
- Ask for failing fixtures with all personal data removed.
- Publish one “adapter checklist” for new agent hosts.
- Keep the roadmap short and evidence-driven.

## Distribution checklist

- English README has a Chinese title explanation.
- Repo description contains the user problem, not only the product name.
- Topics include `ai-agents`, `codex`, `context-engineering`, `llmops`, `token-optimization`, and `cost-optimization`.
- First release links to architecture, deployment, security, and changelog.
- A visitor can run a read-only audit before installing Hooks.
- Rollback is obvious.
- Issues ask for redacted structured output, never full transcripts.

## What “popular” should mean

The useful success signals are:

- users can identify waste in their own sessions;
- users report false positives with reproducible telemetry;
- adapters emerge for different hosts;
- the guard stays small enough to audit;
- downstream integrations preserve the privacy boundary.

Stars are a distribution signal, not evidence that a cost model or safety rule works.
