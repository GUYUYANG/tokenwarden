#!/usr/bin/env node
// Merge the durable task-memory hooks into ~/.codex/hooks.json without
// replacing unrelated hooks. Re-running is idempotent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const HOOK_FILE = path.join(CODEX_HOME, 'hooks.json');
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'codex-task-memory.mjs');
const MARKER = 'codex-task-memory.mjs';

function readHooks() {
  if (!fs.existsSync(HOOK_FILE)) return { description: 'User lifecycle hooks', hooks: {} };
  return JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
}

function backupHooks() {
  if (!fs.existsSync(HOOK_FILE)) return '';
  const stamp = `${Date.now()}-${process.pid}`;
  const backup = `${HOOK_FILE}.tokenwarden-backup-${stamp}`;
  fs.copyFileSync(HOOK_FILE, backup);
  return backup;
}

function withoutOurHook(groups) {
  return (groups || [])
    .map(group => ({
      ...group,
      hooks: (group.hooks || []).filter(hook => !String(hook.command || '').includes(MARKER)),
    }))
    .filter(group => group.hooks.length > 0);
}

export function mergeTaskMemoryHooks(hooks, script = SCRIPT) {
  hooks.hooks ||= {};
  for (const event of ['UserPromptSubmit', 'SessionStart', 'Stop']) {
    hooks.hooks[event] = withoutOurHook(hooks.hooks[event]);
  }
  const command = `node "${script}"`;
  hooks.hooks.UserPromptSubmit.push({
    hooks: [{
      type: 'command',
      command,
      statusMessage: 'Loading relevant task memory',
      timeout: 10,
      additionalContextLimit: 2_400,
    }],
  });
  hooks.hooks.SessionStart.push({
    matcher: 'startup|compact',
    hooks: [{
      type: 'command',
      command,
      statusMessage: 'Restoring durable task facts',
      timeout: 10,
      additionalContextLimit: 2_400,
    }],
  });
  hooks.hooks.Stop.push({
    hooks: [{
      type: 'command',
      command,
      statusMessage: 'Checkpointing task facts',
      timeout: 10,
    }],
  });
  return hooks;
}

function main() {
  const hooks = mergeTaskMemoryHooks(readHooks());
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const backup = backupHooks();
  const temp = `${HOOK_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(hooks, null, 2)}\n`);
  fs.renameSync(temp, HOOK_FILE);
  process.stdout.write(`${HOOK_FILE}\n`);
  if (backup) process.stdout.write(`Backup: ${backup}\n`);
  process.stdout.write('Open /hooks in Codex to review and trust the changed hooks.\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) main();
