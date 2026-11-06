import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../tools/tokenwarden.mjs', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('demo runs the real audit against a synthetic transcript', () => {
  const result = run(['demo', '--json']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /不读取个人会话数据/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.session.id, 'tokenwarden-demo');
  assert.equal(report.workflow.simpleQueryOverhead, true);
  assert.equal(report.workflow.requestChars, 42);
  assert.equal(report.tools.duplicateCalls, 49);
  assert.equal(report.configChangedDuringSession, false);
  assert.equal(report.findings.some(item => item.code === 'config-changed-during-session'), false);
  assert.ok(report.context.overThresholdCalls >= 40);
  assert.ok(report.findings.some(item => item.code === 'simple-query-overhead'));
  assert.ok(report.findings.some(item => item.code === 'repeated-tool-calls'));
  assert.equal(JSON.stringify(report).includes('Where is the session configuration loaded?'), false);
});

test('cli exposes a useful help page and version', () => {
  const help = run(['help']);
  const version = run(['version']);

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /tokenwarden demo/);
  assert.match(help.stdout, /不读取、修改或上传任何本地会话/);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
