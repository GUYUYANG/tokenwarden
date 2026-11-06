# Deployment / 部署

## Prerequisites / 前置条件

- Node.js 22.15 or newer.
  Node.js 22.15 或更新版本。
- A local Codex installation with user Hooks enabled.
  本地 Codex 已安装并启用用户 Hooks。
- A readable Codex session directory, normally `~/.codex/sessions`.
  可读取 Codex 会话目录，默认为 `~/.codex/sessions`。

TokenWarden has no runtime package dependencies and does not require a build.
TokenWarden 没有运行时包依赖，也不需要构建。

## Install / 安装

```bash
git clone https://github.com/GUYUYANG/tokenwarden.git
cd tokenwarden
npm run verify

node tools/install-codex-task-memory.mjs
node tools/install-codex-model-switch-guard.mjs
```

The installers:
安装器会：

- parse the existing `~/.codex/hooks.json`;
  解析现有 `~/.codex/hooks.json`；
- preserve unrelated Hook groups;
  保留无关 Hook 分组；
- remove only an older copy of the same TokenWarden Hook;
  只移除同一 TokenWarden Hook 的旧副本；
- write through a temporary file and atomic rename;
  先写临时文件，再原子重命名；
- create a timestamped backup before replacing an existing file.
  替换现有文件前创建带时间戳的备份。

After installation, open `/hooks` in Codex and review the exact commands. Trust the Hooks only after inspection. Start a new session so the changed configuration can load.
安装后，在 Codex 中打开 `/hooks`，审核每条实际命令。只在检查后选择信任，并启动新会话以加载变更配置。

## Verify / 验证

1. Run the local test suite:
   运行本地测试：

   ```bash
   npm run verify
   ```

2. Run a read-only audit on a small session:
   对小型会话运行只读审计：

   ```bash
   node tools/codex-session-audit.mjs <session-id> --threshold 200000
   ```

3. Open a new session, submit a work request, and confirm the Hook appears as trusted.
   打开新会话，提交一个工作任务，并确认 Hook 状态为已信任。
4. Trigger a real context compaction in a disposable session and confirm the task-memory event log contains an injection.
   在可丢弃的测试会话中触发一次真实上下文压缩，并确认任务记忆事件日志包含注入记录。

The preceding checks validate installation and bounded behavior. The real compaction event is the only proof that the `SessionStart(source=compact)` path ran in your host.
前面的检查用于验证安装和有界行为；只有真实压缩事件才能证明 `SessionStart(source=compact)` 路径已在你的宿主中运行。

## Configuration / 配置

All configuration is through environment variables.
所有配置均通过环境变量完成。

| Variable / 变量 | Default / 默认值 | Purpose / 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex configuration and session root<br>Codex 配置与会话根目录 |
| `TOKENWARDEN_TASK_MEMORY` | enabled<br>启用 | Set to `0`, `false`, `off`, or `no` to disable task memory<br>设为 `0`、`false`、`off` 或 `no` 可禁用任务记忆 |
| `TOKENWARDEN_TASK_MEMORY_DIR` | `~/.codex/tokenwarden/task-memory` | Override task-ledger storage<br>覆盖任务账本存储目录 |
| `TOKENWARDEN_TASK_MEMORY_MAX_CHARS` | `2200` | Maximum injected memory length<br>注入记忆的最大字符数 |
| `TOKENWARDEN_MODEL_SWITCH` | enabled<br>启用 | Disable the model-switch guard with a false-like value<br>使用假值禁用模型切换守卫 |
| `TOKENWARDEN_MODEL_SWITCH_MIN_CONTEXT` | `80000` | Minimum context before model-switch evaluation<br>进行模型切换评估的最低上下文 |
| `TOKENWARDEN_MODEL_SWITCH_BLOCK_CNY` | `0.5` | Estimated first-call input cap<br>首轮输入费用估算上限 |
| `TOKENWARDEN_COST_METER_COMMAND` | `codex-cost-meter` | Optional local pricing CLI command<br>可选的本地价格 CLI 命令 |

The earlier `TOKEN_GUARD_*` names remain supported as aliases for migration compatibility.
为兼容迁移，早期 `TOKEN_GUARD_*` 名称仍可作为别名使用。

If `codex-cost-meter` is unavailable, TokenWarden uses its small built-in price table for known DeepSeek models. Unknown models remain unpriced and are not blocked.
如果 `codex-cost-meter` 不可用，TokenWarden 会使用内置的小型已知 DeepSeek 模型价格表。未知模型保持无价格状态，因此不会被拦截。

## Uninstall / 卸载

```bash
node tools/uninstall-codex-hooks.mjs
```

This removes only commands containing `codex-task-memory.mjs` or `codex-model-switch-guard.mjs`. It preserves unrelated Hooks and creates a backup before writing.
该命令只移除包含 `codex-task-memory.mjs` 或 `codex-model-switch-guard.mjs` 的命令，保留无关 Hooks，并在写入前创建备份。

Local state is intentionally not deleted automatically:
本地状态不会被自动删除：

```text
~/.codex/tokenwarden/
```

Review and remove that directory only if you no longer need the ledger or event history.
只有在不再需要任务账本或事件历史时，才应检查并手动删除该目录。

## DSH adapter / DSH 适配器

`adapters/dsh/` contains the original Cordis host adapter. It demonstrates:
`adapters/dsh/` 包含原始 Cordis 宿主适配器，用于演示：

- tool-description reduction;
  工具描述瘦身；
- historical reasoning filtering;
  历史推理过滤；
- a per-turn estimate cap;
  单轮费用估算上限；
- balance gating;
  余额闸门；
- a host-side compaction fallback.
  宿主侧上下文压缩回退。

This adapter is host-specific and should be installed through the DSH plugin bundle mechanism. Its event names and service lookups are not part of the portable core. Do not treat Codex Hook instructions as DSH installation instructions, or vice versa.
该适配器属于特定宿主，应通过 DSH 插件包机制安装。它的事件名和服务查找不属于可移植核心。不要将 Codex Hook 安装说明与 DSH 安装说明混用。

## Compatibility / 兼容性

| Surface / 场景 | Status / 状态 |
| --- | --- |
| Node.js 22.15+ | Required<br>必需 |
| macOS local Codex Hooks<br>macOS 本地 Codex Hooks | Runtime-tested by the maintainer<br>由维护者完成实机测试 |
| Linux Node environment<br>Linux Node 环境 | Covered by CI<br>由 CI 覆盖 |
| Windows | Not runtime-verified<br>尚未实机验证 |
| Codex rollout JSONL | Supported<br>支持 |
| Codex `.jsonl.zst` audit | Requires Node.js with Zstandard support<br>需要支持 Zstandard 的 Node.js |
| DSH adapter / DSH 适配器 | Host-specific / experimental<br>特定宿主 / 实验性 |

The deployment remains local-first. No third-party service is contacted by the audit or task-memory code. Optional pricing calls only execute the configured local CLI.
部署保持本地优先。审计与任务记忆代码不会联系第三方服务；可选价格查询只执行用户配置的本地 CLI。
