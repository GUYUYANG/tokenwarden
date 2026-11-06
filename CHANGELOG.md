# Changelog / 更新日志

## v0.1.1 — First-run proof / 首次运行证明 — 2026-11-06

- Added a zero-dependency `tokenwarden` CLI with `demo`, `audit`, `install`, and `uninstall` commands.
  增加零依赖 `tokenwarden` CLI，提供演示、审计、安装和卸载命令。
- Added a temporary synthetic transcript so visitors can see the real audit findings without exposing a personal session.
  增加临时合成会话，让访客无需暴露个人会话就能看到真实审计结果。
- Added a terminal visual and moved the reproducible proof above the fold in both READMEs.
  增加终端演示图，并在双语 README 首屏放置可复现证据。
- Made the package publishable and installable directly from GitHub.
  将包改为可发布，并支持直接从 GitHub 安装。

## v0.1.0 — Public preview / 公开预览 — 2026-11-06

- Relicensed under GPL-3.0-only. / 项目改用 GPL-3.0-only 许可证。
- Public preview of the local-first session audit.
  发布本地优先会话审计的公开预览。
- Durable task-memory ledger with selective injection after compaction.
  提供持久任务记忆账本，并在上下文压缩后按条件注入。
- Repeated-failure circuit breaker requiring a new hypothesis and evidence.
  提供重复失败熔断，要求新假设和新证据。
- Model-switch budget planning and blocking.
  提供模型切换预算规划与拦截。
- Idempotent Codex Hook installers with backups and a scoped uninstaller.
  提供可重复执行、自动备份且支持定向卸载的 Codex Hook 安装器。
- DSH Cordis adapter for host-specific experimentation.
  提供用于特定宿主实验的 DSH Cordis 适配器。
- Dependency-free Node.js test suite and GitHub Actions CI.
  提供无依赖 Node.js 测试套件与 GitHub Actions CI。
