#!/usr/bin/env node
// Merge the model-switch guard into the user's Codex hooks without replacing
// unrelated hooks. Re-running is idempotent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const HOOK_FILE = path.join(CODEX_HOME, 'hooks.json');
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'codex-model-switch-guard.mjs');
const SCRIPT_MARKER = 'codex-model-switch-guard.mjs';

function readHooks() {
  if (!fs.existsSync(HOOK_FILE)) {
    return {
      description: 'User lifecycle hooks',
      hooks: {},
    };
  }
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
      hooks: (group.hooks || []).filter(hook => !String(hook.command || '').includes(SCRIPT_MARKER)),
    }))
    .filter(group => group.hooks.length > 0);
}

function command() {
  return `node "${SCRIPT}"`;
}

const hooks = readHooks();
hooks.hooks ||= {};
hooks.hooks.UserPromptSubmit = withoutOurHook(hooks.hooks.UserPromptSubmit);
hooks.hooks.Stop = withoutOurHook(hooks.hooks.Stop);

hooks.hooks.UserPromptSubmit.push({
  hooks: [{
    type: 'command',
    command: command(),
    statusMessage: 'Checking model-switch token budget',
    timeout: 10,
    additionalContextLimit: 1200,
  }],
});
hooks.hooks.Stop.push({
  hooks: [{
    type: 'command',
    command: command(),
    statusMessage: 'Recording model context for token budget',
    timeout: 5,
  }],
});

fs.mkdirSync(CODEX_HOME, { recursive: true });
const backup = backupHooks();
const temp = `${HOOK_FILE}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(hooks, null, 2)}\n`);
fs.renameSync(temp, HOOK_FILE);
console.log(HOOK_FILE);
if (backup) console.log(`Backup: ${backup}`);
console.log('Restart or open /hooks in Codex to review and trust the changed hook.');
