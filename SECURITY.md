# Security and privacy / 安全与隐私

## Threat model / 威胁模型

TokenWarden runs local code with the permissions of the current user. It reads local session metadata and may inject text into an AI-agent session. A malicious local modification to the repository or `hooks.json` can execute arbitrary commands.
TokenWarden 以当前用户权限运行本地代码，读取本地会话元数据，并可能向 AI 代理会话注入文本。对仓库或 `hooks.json` 的恶意本地修改可以执行任意命令。

Mitigations:
缓解措施：

- no runtime dependencies;
  无运行时依赖；
- no telemetry or analytics;
  无遥测或分析服务；
- installers preserve unrelated Hooks;
  安装器保留无关 Hooks；
- installers back up `hooks.json`;
  安装器备份 `hooks.json`；
- Hook commands can be reviewed before trust;
  Hook 命令可在信任前审核；
- an uninstaller removes only TokenWarden markers.
  卸载器只移除 TokenWarden 标记。

## Local data / 本地数据

Task-ledger state is stored under:
任务账本状态保存在：

```text
~/.codex/tokenwarden/
```

The task ledger may contain concise user statements, acceptance criteria, file paths, and verification summaries. It is intended to be sensitive local data. It is not encrypted.
任务账本可能包含精简用户陈述、验收条件、文件路径和验证摘要。它应被视为敏感本地数据，并且没有加密。

The model-switch log records model names, context size, estimated cost, actions, and timestamps. It does not record prompt or transcript text.
模型切换日志记录模型名、上下文规模、估算费用、操作和时间戳，不记录提示词或会话正文。

## Sharing audit output / 分享审计输出

The read-only audit does not print prompts, assistant messages, reasoning blocks, tool arguments, or raw tool output. Its JSON can still contain:
只读审计不会输出提示词、助手消息、推理块、工具参数或原始工具输出，但 JSON 仍可能包含：

- session ID;
  会话 ID；
- working directory;
  工作目录；
- session file path;
  会话文件路径；
- model and provider names;
  模型和供应商名称；
- tool names and counts.
  工具名称和计数。

Review and redact these fields before attaching an audit to a public issue.
将审计结果附到公开 Issue 前，必须检查并脱敏这些字段。

## Reporting a vulnerability / 报告安全漏洞

Do not include a full session transcript in a public issue. Open a minimal private security report through the repository's GitHub Security tab when available, or contact the maintainer with:
不要在公开 Issue 中包含完整会话。若仓库可用 GitHub Security 页面，请提交最小化私密报告；也可以向维护者提供：

1. affected version or commit;
   受影响的版本或提交；
2. a minimal synthetic reproduction;
   最小合成复现；
3. expected and observed behavior;
   预期行为与实际行为；
4. whether local files, hooks, or credentials are at risk.
   本地文件、Hooks 或凭据是否面临风险。
