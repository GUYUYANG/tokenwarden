# Iteration principles / 迭代原则

This file records general engineering decisions, not user tasks or session content.
本文件只记录可泛化的工程决策，不记录用户任务或会话内容。

| Version / 版本 | Change / 变化 | Reason / 原因 |
| --- | --- | --- |
| v0 | Observe token usage and cap an expensive turn<br>观察 token 用量并限制高成本轮次 | A budget without telemetry cannot explain itself<br>没有遥测的预算无法解释自身 |
| v1 | Add structured audit and model-switch checks<br>增加结构化审计和模型切换检查 | Measure where replay pressure enters before changing context<br>修改上下文前先测量回放压力来自哪里 |
| v2 | Split host integration from portable rules<br>拆开宿主集成与可移植规则 | Host event names and trust models change independently<br>宿主事件名和信任模型会独立变化 |
| v0.1 public preview<br>v0.1 公开预览 | Add durable task memory and a repeated-failure breaker<br>增加持久任务记忆和重复失败熔断 | Summaries preserve text but can lose confirmed facts and rejected hypotheses<br>摘要能保留文本，却可能丢失确认事实和已否定假设 |

## Recurring principles / 持续适用的原则

1. Optimize the multiplier with the strongest evidence, not the most impressive-sounding mechanism.
   优先优化证据最强的成本因子，而不是听起来最复杂的机制。
2. Treat a user correction as a state transition, not as another paragraph in a summary.
   把用户纠错视为状态转换，而不是摘要里的另一段文字。
3. Keep source-of-truth facts separate from generated summaries.
   把权威事实与生成式摘要分开保存。
4. After repeated failure, change the hypothesis or collect new evidence before changing code again.
   重复失败后，先更换假设或采集新证据，再继续改代码。
5. Keep injection conditional; unrelated lookups should not inherit debugging state.
   保持条件注入；无关查询不应继承调试状态。
6. Store structured counters and bounded summaries when full history is not required.
   不需要完整历史时，只保存结构化计数和有界摘要。
7. Make unknown states explicit and fail open when safety depends on missing telemetry.
   显式标记未知状态；当安全判断依赖缺失遥测时，选择安全放行。
