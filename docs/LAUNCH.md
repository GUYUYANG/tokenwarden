# Launch playbook / 发布指南

The project should spread through a reproducible artifact, not through claims that it makes an agent “smarter.”
这个项目应依靠可复现的工程产物传播，而不是靠“让代理更聪明”的口号。

## Positioning / 定位

Primary line:
主文案：

> Long agent sessions do not only fail because the model is weak. They fail because every step carries stale context and every retry can forget what was already ruled out.
> 长会话代理失效，不只是因为模型能力弱；也因为每一步都携带过时上下文，每次重试都可能忘记已经排除的假设。

Secondary line:
辅助文案：

> TokenWarden makes agent cost and loop waste visible, then keeps only the facts that must survive a long session.
> TokenWarden 让代理成本与循环浪费变得可见，只保留长会话必须延续的事实。

Avoid:
避免：

- promising a universal percentage reduction;
  承诺适用于所有场景的固定节省比例；
- claiming that an agent will never repeat a bug;
  声称代理永远不会重复某个缺陷；
- presenting synthetic or local measurements as benchmarks;
  把合成测试或本地测量当作通用基准；
- leading with implementation details before showing the user-visible problem.
  在展示用户可见问题之前先堆实现细节。

## Cold start / 冷启动

Third-party media is optional; external distribution is not. GitHub is the conversion page, not a guaranteed discovery engine for a new repository.
第三方媒体不是必需品，但外部触达不是可选项。GitHub 是转化页，而不是新仓库的自动流量来源。

Start with 3–5 people who already report long, expensive agent sessions. Ask them to run the synthetic demo first, then a redacted audit in their own environment. Ask about false positives, missed patterns, and installation failures instead of asking for stars.
先找 3–5 个已经在抱怨长会话昂贵或重复修 bug 的用户。请他们先运行合成演示，再在自己的环境里跑一次脱敏审计。询问误报、漏报和安装失败，而不是只要 star。

Useful early signals are ten successful first runs, three reproducible feedback reports, and one repeat user. Views without successful runs are not evidence that the project is useful.
有价值的早期信号是十次成功首次运行、三份可复现反馈，以及一个重复使用用户。没有成功运行的浏览量不能证明项目有用。

## 60-second proof / 60 秒证明

1. Run `npx --yes github:GUYUYANG/tokenwarden demo`.
   运行 `npx --yes github:GUYUYANG/tokenwarden demo`。
2. Show the synthetic audit containing context replay, repeated tool calls, and simple-query overhead.
   展示包含上下文回放、重复工具调用和简单查询开销的合成审计。
3. Show the calculator: `calls × active context × price`.
   展示计算关系：`调用次数 × 当前上下文 × 单价`。
4. Show one compact task-ledger injection.
   展示一次紧凑任务账本注入。
5. Show that an unrelated lookup does not receive the ledger.
   展示无关查询不会收到任务账本。
6. Show the uninstall command.
   展示卸载命令。

## Launch sequence / 发布节奏

### Day 0: publish a usable first release / 第 0 天：发布可用首版

- Tag `v0.1.0`.
  创建 `v0.1.0` 标签。
- Keep CI green.
  保持 CI 通过。
- Pin one issue asking users for a redacted audit pattern.
  置顶一个征集脱敏审计模式的 Issue。
- Include one short GIF or terminal recording when available.
  有素材时附上一段短 GIF 或终端录屏。

### Day 1: technical communities / 第 1 天：技术社区

Suggested title:
建议标题：

> Show HN: TokenWarden – find and reduce context waste in AI coding agents
> Show HN：TokenWarden —— 找出并减少 AI 编程代理中的上下文浪费

Suggested bilingual body:
建议双语正文：

> I kept seeing long coding sessions become slow and expensive even after compaction. The transcript usually shows two different things: replay of context the next step no longer needs, and repeated attempts around a hypothesis the user already rejected. TokenWarden is a local-first audit plus task ledger. It does not call another model. The repo includes the audit, selective memory injection, loop breaker, and uninstall path. I would especially value feedback from people who have large local Codex or agent transcripts.
>
> 我看到很多长编程会话即使经过压缩，仍然又慢又贵。会话记录通常暴露两类问题：下一步已经不需要的上下文仍被反复回放，以及用户早已否定的假设仍被反复尝试。TokenWarden 是本地优先的审计器加任务账本，不调用第二个模型。仓库包含审计、选择性记忆注入、循环熔断和卸载路径。尤其希望拥有大型本地 Codex 会话或其他代理会话的用户反馈。

Chinese community version:
中文社区版本：

> 做了个本地工具 TokenWarden（词元卫士），不靠第二个模型“监督”第一个模型，而是用结构化遥测找出长会话里的上下文回放和重复修复循环。它会保留用户已确认事实、已否定假设和未完成验收，压缩后只恢复这部分。附带只读审计器、Codex Hook、DSH 适配器、测试和一键卸载。欢迎大家拿真实的脱敏会话打脸。

### Day 2: show evidence / 第 2 天：展示证据

Publish a redacted before/after analysis:
发布一份脱敏的前后分析：

- what the audit measured;
  审计实际测量了什么；
- which finding was actionable;
  哪项发现可以采取行动；
- what rule changed;
  改动了哪条规则；
- what remained uncertain;
  还有哪些不确定性；
- the exact reproduction command.
  精确的复现命令。

Do not aggregate unrelated test passes into an impact claim.
不要把无关测试通过合并成效果结论。

### Week 1: make contribution easy / 第 1 周：降低贡献门槛

- Label adapter and audit-pattern issues as `help wanted`.
  给适配器和审计模式 Issue 添加 `help wanted` 标签。
- Ask for failing fixtures with all personal data removed.
  征集移除全部个人数据后的失败测试样例。
- Publish one “adapter checklist” for new agent hosts.
  发布一份面向新代理宿主的“适配器检查清单”。
- Keep the roadmap short and evidence-driven.
  保持路线图简短，并由证据驱动。

## Distribution checklist / 传播检查清单

- English README has a Chinese title explanation.
  英文 README 同时包含中文标题解释。
- Repo description contains the user problem, not only the product name.
  仓库描述包含用户问题，而不只是产品名。
- Topics include `ai-agents`, `codex`, `context-engineering`, `llmops`, `token-optimization`, and `cost-optimization`.
  仓库 Topic 包含相关英文发现词；这些是 GitHub 检索标识，不另翻译。
- First release links to architecture, deployment, security, and changelog.
  首个 Release 链接到架构、部署、安全和更新日志。
- A visitor can run a read-only audit before installing Hooks.
  访问者可以在安装 Hooks 前先运行只读审计。
- Rollback is obvious.
  回滚方式清晰可见。
- Issues ask for redacted structured output, never full transcripts.
  Issue 只要求脱敏结构化输出，绝不要求完整会话。

## What “popular” should mean / “火”应该意味着什么

The useful success signals are:
有价值的成功信号包括：

- users can identify waste in their own sessions;
  用户能识别自己会话中的浪费；
- users report false positives with reproducible telemetry;
  用户能用可复现遥测报告误报；
- adapters emerge for different hosts;
  社区为不同宿主贡献适配器；
- the guard stays small enough to audit;
  守卫保持足够小，便于人工审核；
- downstream integrations preserve the privacy boundary.
  下游集成继续遵守隐私边界。

Stars are a distribution signal, not evidence that a cost model or safety rule works.
Star 是传播信号，不是成本模型或安全规则有效的证据。
