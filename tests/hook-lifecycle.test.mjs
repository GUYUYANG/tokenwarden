import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function run(script, codexHome) {
  return spawnSync(process.execPath, [path.resolve(script)], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
  });
}

test('installers preserve unrelated hooks, create backups, and uninstall cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenwarden-lifecycle-'));
  const hooksFile = path.join(root, 'hooks.json');
  fs.writeFileSync(hooksFile, JSON.stringify({
    description: 'test',
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: 'node unrelated.mjs' }],
      }],
    },
  }, null, 2));

  const taskInstall = run('tools/install-codex-task-memory.mjs', root);
  assert.equal(taskInstall.status, 0, taskInstall.stderr);
  const modelInstall = run('tools/install-codex-model-switch-guard.mjs', root);
  assert.equal(modelInstall.status, 0, modelInstall.stderr);

  let hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const commands = Object.values(hooks.hooks)
    .flat()
    .flatMap(group => group.hooks || [])
    .map(hook => hook.command);
  assert.equal(commands.filter(command => command.includes('codex-task-memory')).length, 3);
  assert.equal(commands.filter(command => command.includes('codex-model-switch-guard')).length, 2);
  assert.equal(commands.filter(command => command.includes('unrelated')).length, 1);

  const backups = fs.readdirSync(root).filter(name => name.includes('tokenwarden-backup-'));
  assert.equal(backups.length, 2);

  const uninstall = run('tools/uninstall-codex-hooks.mjs', root);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const remaining = Object.values(hooks.hooks)
    .flat()
    .flatMap(group => group.hooks || [])
    .map(hook => hook.command);
  assert.deepEqual(remaining, ['node unrelated.mjs']);

  fs.rmSync(root, { recursive: true, force: true });
});
