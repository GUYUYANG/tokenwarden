#!/usr/bin/env node
// Remove only hooks installed by TokenWarden. Unrelated hooks stay untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const HOOK_FILE = path.join(CODEX_HOME, 'hooks.json');
const MARKERS = [
  'codex-task-memory.mjs',
  'codex-model-switch-guard.mjs',
];

if (!fs.existsSync(HOOK_FILE)) {
  process.stdout.write('No Codex hooks file found; nothing to remove.\n');
  process.exit(0);
}

const hooks = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
hooks.hooks ||= {};

for (const [event, groups] of Object.entries(hooks.hooks)) {
  hooks.hooks[event] = (groups || [])
    .map(group => ({
      ...group,
      hooks: (group.hooks || []).filter(hook => {
        const command = String(hook.command || '');
        return !MARKERS.some(marker => command.includes(marker));
      }),
    }))
    .filter(group => group.hooks.length > 0);
}

const stamp = `${Date.now()}-${process.pid}`;
const backup = `${HOOK_FILE}.tokenwarden-backup-${stamp}`;
fs.copyFileSync(HOOK_FILE, backup);
const temp = `${HOOK_FILE}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(hooks, null, 2)}\n`);
fs.renameSync(temp, HOOK_FILE);

process.stdout.write(`${HOOK_FILE}\n`);
process.stdout.write(`Backup: ${backup}\n`);
process.stdout.write('TokenWarden hooks removed. Open /hooks in Codex to review the change.\n');
