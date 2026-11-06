#!/usr/bin/env node
// Small zero-dependency entry point for demos, audits, and Codex Hook management.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function usage() {
  console.log(`TokenWarden / 词元卫士

Usage / 用法:
  tokenwarden demo [--json]
  tokenwarden audit <session-id|session.jsonl> [audit options]
  tokenwarden install [task-memory|model-switch|all]
  tokenwarden uninstall
  tokenwarden version

The demo generates a temporary synthetic transcript. It does not read,
modify, or upload your local sessions.
演示会生成临时合成会话，不读取、修改或上传任何本地会话。

Run "tokenwarden audit --help" for audit-specific options.
运行 "tokenwarden audit --help" 查看审计参数。`);
}

function runNode(script, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function writeDemoTranscript(file) {
  const at = '2026-11-06T08:00:00.000Z';
  const args = JSON.stringify({
    command: ['rg', '-n', 'session', 'README.md'],
  });
  const records = [
    {
      timestamp: at,
      type: 'session_meta',
      payload: {
        id: 'tokenwarden-demo',
        cwd: '/tmp/tokenwarden-demo',
        model_provider: 'synthetic',
        provenance: { model: 'synthetic-agent' },
        timestamp: at,
      },
    },
    {
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Where is the session configuration loaded?' }],
      },
    },
  ];

  for (let i = 0; i < 50; i++) {
    records.push(
      {
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: `lookup-${i}`,
          arguments: args,
        },
      },
      {
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: `lookup-${i}`,
          output: i === 0 ? 'X'.repeat(18_000) : 'No additional matches.',
        },
      },
      {
        timestamp: at,
        type: 'token_usage_record',
        payload: {
          response_id: `usage-${i}`,
          usage: {
            input_tokens: 210_000 + i * 1_000,
            cached_input_tokens: 180_000,
            output_tokens: 120,
          },
        },
      },
    );
  }

  for (let i = 0; i < 100; i++) {
    records.push({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', id: `command-${i}` },
      },
    });
  }

  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function demo(args) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenwarden-demo-'));
  const transcript = path.join(tempDir, 'synthetic-session.jsonl');
  try {
    writeDemoTranscript(transcript);
    console.error('Synthetic demo / 合成演示：no personal session data is read; 不读取个人会话数据。\n');
    return runNode('tools/codex-session-audit.mjs', [transcript, ...args], {
      CODEX_HOME: tempDir,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function install(args) {
  const requested = args.length ? args : ['all'];
  const installers = {
    'task-memory': 'tools/install-codex-task-memory.mjs',
    'model-switch': 'tools/install-codex-model-switch-guard.mjs',
  };
  const names = requested.includes('all') ? Object.keys(installers) : requested;
  for (const name of names) {
    if (!installers[name]) throw new Error(`Unknown Hook: ${name}`);
    const status = runNode(installers[name], []);
    if (status !== 0) return status;
  }
  console.log('\nNext / 下一步：open /hooks in Codex, review the commands, and trust them.');
  console.log('在 Codex 中打开 /hooks，审核命令后选择信任。');
  return 0;
}

function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(packageJson.version);
    return 0;
  }
  if (command === 'demo') {
    if (args.some(arg => arg !== '--json')) throw new Error('Demo accepts only --json.');
    return demo(args);
  }
  if (command === 'audit') return runNode('tools/codex-session-audit.mjs', args);
  if (command === 'install') return install(args);
  if (command === 'uninstall') return runNode('tools/uninstall-codex-hooks.mjs', args);
  throw new Error(`Unknown command: ${command}\n运行 "tokenwarden help" 查看用法。`);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
