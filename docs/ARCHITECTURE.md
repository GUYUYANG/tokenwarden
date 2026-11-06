# Architecture / 架构

TokenWarden is intentionally small. It separates what is portable from what is host-specific.
TokenWarden 刻意保持小而清晰，并把可移植的核心能力与特定宿主的集成方式分开。

```text
portable core / 可移植核心
├── structured telemetry reader / 结构化遥测读取器
├── bounded task ledger / 有界任务账本
├── deterministic decision rules / 确定性决策规则
└── privacy boundary / 隐私边界

host adapters / 宿主适配器
├── Codex: hooks.json + rollout JSONL
└── DSH: Cordis plugin events / Cordis 插件事件
```

## Cost model / 成本模型

The project starts with an observable model rather than a guess:
项目先建立可观察的模型，而不是依赖猜测：

```text
work ≈ model calls × active context
工作量 ≈ 模型调用次数 × 当前上下文
```

Changing the model price multiplies both terms. The audit therefore reports:
模型单价会同时放大这两个因子。因此，审计器会报告：

- model calls;
  模型调用次数；
- input, cached input, and output tokens;
  输入、缓存输入和输出 token；
- context samples above a configurable threshold;
  超过可配置阈值的上下文样本；
- repeated tool calls and repeated output size;
  重复工具调用及其重复输出规模；
- compaction frequency;
  上下文压缩频率；
- command and tool-call counts before the first mutation;
  首次真实修改前的命令和工具调用数量；
- a counterfactual excess-input estimate only when pricing is known.
  仅在价格已知时计算超阈值输入的反事实估算。

The counterfactual estimate is not a savings guarantee. It indicates where replay pressure exists.
反事实估算不是节省保证，只用于指出回放压力出现在哪里。

## Task ledger / 任务账本

The task-memory adapter reads structured transcript records and maintains a compact ledger with:
任务记忆适配器读取结构化会话记录，并维护一份紧凑账本，其中包含：

- task type and goal;
  任务类型和目标；
- user statements and confirmed facts;
  用户陈述和确认事实；
- assistant hypotheses, including rejected state;
  助手假设及是否已被否定；
- pending acceptance checks;
  尚未完成的验收条件；
- touched files;
  涉及的文件；
- structured verification events;
  结构化验证事件；
- latest assistant conclusion and whether it was later contradicted;
  最近的助手结论，以及后来是否被反证；
- repeated-failure count;
  重复失败计数；
- a byte cursor for incremental reads.
  用于增量读取的字节游标。

Each event updates the ledger atomically. The model receives a bounded text rendering, never the raw transcript.
每个事件都会原子更新账本。模型只会收到有长度限制的文本渲染结果，不会收到原始会话全文。

Injection is selective:
注入是有条件的：

| Event / 事件 | Inject? / 是否注入 | Reason / 原因 |
| --- | --- | --- |
| `SessionStart(source=compact)` | Work sessions only<br>仅工作会话 | Restore facts after a summary boundary<br>在摘要边界后恢复事实 |
| Correction or complaint / 纠错或投诉 | Yes<br>是 | Prevent a rejected assumption from returning<br>防止已否定假设重新出现 |
| Explicit continuation / 明确继续 | Yes<br>是 | Reuse the active task state<br>复用当前任务状态 |
| Standalone lookup in a work session / 工作会话中的独立查询 | No<br>否 | Avoid polluting an unrelated query<br>避免污染无关查询 |
| Query-only session / 仅查询会话 | No, unless it becomes work<br>否，除非转成工作任务 | Queries do not carry debugging state<br>查询不携带调试状态 |

The current-turn user message has higher priority than historical assistant statements. A rejected hypothesis remains disabled until new evidence is observed.
当前轮用户消息的优先级高于历史助手陈述。被否定的假设会持续禁用，直到观察到新证据。

## Failure circuit breaker / 重复失败熔断

Complaints and repeated failed acceptance checks increment a loop counter. Once the count reaches two:
用户投诉和重复失败的验收会让循环计数增加。计数达到两次后：

1. the next step must state a falsifiable hypothesis;
   下一步必须提出可证伪的新假设；
2. the hypothesis must be checked against new runtime evidence;
   新假设必须用新的运行证据检验；
3. another similar patch is no longer acceptable without that evidence;
   没有新证据时，不再接受另一个相似补丁；
4. if no evidence path exists, the task should be reported as blocked.
   如果不存在可执行的取证路径，应明确报告任务受阻。

This is a context rule, not a semantic judge. It cannot prove that two patches are different; it prevents the system from silently forgetting that the previous path failed.
这是一条上下文规则，不是语义裁判。它无法证明两个补丁一定不同，但可以防止系统悄悄忘记上一条路径已经失败。

## Model-switch guard / 模型切换守卫

The model-switch guard restores the previous model from local state and structured transcript metadata. It compares known model prices and current context size before the first prompt after a switch.
模型切换守卫会从本地状态和结构化会话元数据中恢复切换前的模型，并在切换后的首个提示词前比较已知价格与当前上下文规模。

Decision bands:
决策区间：

- below the context threshold: no action;
  低于上下文阈值：不操作；
- cheaper or similarly priced model: no action;
  切换后价格更低或相近：不操作；
- more expensive model with a bounded first-call estimate: inject a compact execution plan;
  更贵模型且首轮估算有界：注入紧凑执行计划；
- first-call estimate above the configured cap: block once and recommend compaction or a handoff.
  首轮估算超过配置上限：拦截一次，并建议压缩上下文或生成交接。

If either model has no known price, the guard does nothing. It degrades open rather than guessing.
任一模型缺少已知价格时，守卫不做拦截。它选择安全放行，不会猜测价格。

## Storage / 存储

```text
~/.codex/tokenwarden/
├── model-switch-state.json
├── model-switch-events.jsonl
└── task-memory/
    ├── <session-id>.json
    └── events.jsonl
```

State files use atomic rename. Event logs contain decisions and counters, not prompts, responses, reasoning, or raw tool output.
状态文件使用原子重命名写入。事件日志只包含决策和计数，不包含提示词、回答、推理或原始工具输出。

## Extending to another host / 扩展到其他宿主

An adapter needs:
一个宿主适配器需要：

1. a read-only transcript or event source with model and usage metadata;
   带模型和用量元数据的只读会话或事件源；
2. a way to inject bounded context before a turn;
   在每轮开始前注入有界上下文的方法；
3. a session identifier;
   会话标识；
4. a compaction or checkpoint signal;
   上下文压缩或检查点信号；
5. an explicit trust model for local command execution.
   明确的本地命令执行信任模型。

The ledger and audit logic can be reused. Event names, installation, and trust prompts cannot be assumed across hosts.
任务账本和审计逻辑可以复用，但事件名、安装方式和信任提示不能默认跨宿主一致。
