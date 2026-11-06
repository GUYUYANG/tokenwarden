import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeTranscript,
  describeTaskState,
  handleHook,
} from '../tools/codex-task-memory.mjs';
import { mergeTaskMemoryHooks } from '../tools/install-codex-task-memory.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-task-memory-'));
}

function message(role, text, timestamp = '2026-11-06T10:00:00.000Z') {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
  };
}

function writeTranscript(file, records) {
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('work task keeps goal and creates a loop breaker after repeated failure', async () => {
  const root = tempDir();
  const transcript = path.join(root, 'session.jsonl');
  writeTranscript(transcript, [
    {
      type: 'session_meta',
      payload: { session_id: 's1', cwd: '/tmp/demo' },
    },
    message('user', '修复离线缓存重复写入的问题，验收是同一记录只出现一次。'),
    message('assistant', '一个可能原因是缓存恢复了上次数据。'),
    message('user', '不是缓存恢复，我已经测过，启动时是空数据。还是没解决。'),
    message('user', '同一个问题还是一样，告诉我到底哪里错了。'),
    { type: 'compacted', timestamp: '2026-11-06T10:01:00.000Z', payload: { message: '不要使用。' } },
  ]);

  const state = await analyzeTranscript({
    sessionId: 's1',
    goal: '',
    cwd: '',
    taskKind: 'unknown',
    userStatements: [],
    confirmedFacts: [],
    hypotheses: [],
    acceptance: [],
    files: [],
    evidence: [],
    latestAssistant: '',
    nextStep: '',
    loop: { count: 0, signature: '', updatedAt: '' },
    compactionCount: 0,
    cursor: { offset: 0 },
  }, transcript);
  const context = describeTaskState(state);

  assert.equal(state.taskKind, 'work');
  assert.match(state.goal, /修复离线缓存/);
  assert.ok(state.hypotheses.some(item => item.status === 'rejected' && /缓存恢复/.test(item.text)));
  assert.ok(state.loop.count >= 2);
  assert.match(context, /已否定假设/);
  assert.match(context, /禁止再次作为当前原因/);
  assert.match(context, /重复失败熔断/);
  assert.ok(context.length <= 2_200);
  fs.rmSync(root, { recursive: true, force: true });
});

test('user failure report invalidates the latest assistant completion claim', async () => {
  const root = tempDir();
  const transcript = path.join(root, 'claim.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'claim-1', cwd: root } },
    message('user', '修复列表重复的问题。'),
    message('assistant', '我已经修复并发布了新版本。'),
    message('user', '还是一样，没有解决。'),
  ]);
  const state = {
    sessionId: 'claim-1',
    goal: '',
    cwd: '',
    taskKind: 'unknown',
    userStatements: [],
    confirmedFacts: [],
    hypotheses: [],
    acceptance: [],
    files: [],
    evidence: [],
    latestAssistant: '',
    latestAssistantStatus: 'unverified',
    nextStep: '',
    loop: { count: 0, signature: '', updatedAt: '' },
    compactionCount: 0,
    cursor: { offset: 0 },
  };
  await analyzeTranscript(state, transcript);
  const context = describeTaskState(state);
  assert.match(context, /最近助手结论（已被用户随后否定，不得当作完成证据）：我已经修复并发布了新版本/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('simple query does not inherit debugging context', async () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'query.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'query-1', cwd: root } },
    message('user', '帮我查一下 React 的 useEffect 是什么？'),
  ]);
  const result = await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'query-1',
    thread_id: 'query-1',
    transcript_path: transcript,
    prompt: '帮我查一下 React 的 useEffect 是什么？',
  }, { maxChars: 2_200, stateDir });
  assert.equal(result.output, null);
  assert.equal(result.state.taskKind, 'query');
  assert.ok(fs.existsSync(path.join(stateDir, 'query-1.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('standalone query inside a work session does not inject debugging context', async () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'mixed.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'mixed-1', cwd: root } },
    message('user', '修复列表重复的问题。'),
  ]);
  const first = await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'mixed-1',
    transcript_path: transcript,
  }, { stateDir });
  assert.equal(first.state.taskKind, 'work');
  const query = await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'mixed-1',
    transcript_path: transcript,
    prompt: '帮我查一下这个项目有没有相关文档',
  }, { stateDir });
  assert.equal(query.output, null);
  assert.equal(query.state.taskKind, 'work');
  fs.rmSync(root, { recursive: true, force: true });
});

test('compaction restores user-confirmed facts instead of the generated summary', async () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'compact.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'compact-1', cwd: root } },
    message('user', '修复导入任务重复。'),
    message('assistant', '通常是本地缓存恢复了旧数据。下一步：清理缓存。'),
    message('user', '和本地缓存无关，我都测了，启动时缓存是空的。'),
    message('assistant', '不是缓存造成的，根因是导入队列竞态。'),
    { type: 'compacted', timestamp: '2026-11-06T10:02:00.000Z', payload: { message: '通常是缓存恢复了旧数据。' } },
  ]);
  const result = await handleHook({
    hook_event_name: 'SessionStart',
    source: 'compact',
    session_id: 'compact-1',
    thread_id: 'compact-1',
    transcript_path: transcript,
  }, { stateDir });
  const context = result.output.hookSpecificOutput.additionalContext;
  assert.equal(result.output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context, /本地缓存无关/);
  assert.match(context, /\[助手旧推断\] 通常是本地缓存恢复了旧数据/);
  assert.match(context, /最近助手结论[^\n]*不是缓存造成的/);
  assert.doesNotMatch(context, /下一步：清理缓存/);
  assert.match(context, /不得覆盖用户确认事实/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('incremental analysis does not double-count compaction or replay old messages', async () => {
  const root = tempDir();
  const transcript = path.join(root, 'incremental.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'incremental-1', cwd: root } },
    message('user', '修复这个问题。'),
    { type: 'compacted', timestamp: '2026-11-06T10:03:00.000Z', payload: {} },
  ]);
  const state = {
    sessionId: 'incremental-1',
    goal: '',
    cwd: '',
    taskKind: 'unknown',
    userStatements: [],
    confirmedFacts: [],
    hypotheses: [],
    acceptance: [],
    files: [],
    evidence: [],
    latestAssistant: '',
    nextStep: '',
    loop: { count: 0, signature: '', updatedAt: '' },
    compactionCount: 0,
    cursor: { offset: 0 },
  };
  await analyzeTranscript(state, transcript);
  assert.equal(state.compactionCount, 1);
  await analyzeTranscript(state, transcript);
  assert.equal(state.compactionCount, 1);
  assert.equal(state.userStatements.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hook installer is idempotent and preserves unrelated hooks', () => {
  const hooks = {
    description: 'test',
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: 'node unrelated.mjs' }],
      }],
      Stop: [],
    },
  };
  mergeTaskMemoryHooks(hooks, '/tmp/codex-task-memory.mjs');
  mergeTaskMemoryHooks(hooks, '/tmp/codex-task-memory.mjs');
  const commands = Object.values(hooks.hooks)
    .flat()
    .flatMap(group => group.hooks || [])
    .map(hook => hook.command);
  assert.equal(commands.filter(command => command.includes('codex-task-memory')).length, 3);
  assert.equal(commands.filter(command => command.includes('unrelated')).length, 1);
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|compact');
});

test('search CLI returns targeted transcript messages without dumping the session', () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'search.jsonl');
  writeTranscript(transcript, [
    message('user', '缓存恢复已经排除，启动时是空数据。'),
    message('assistant', '已检查导入顺序。'),
  ]);
  const result = spawnSync(process.execPath, [
    path.resolve('tools/codex-task-memory.mjs'),
    'search',
    '--session', 'search-1',
    '--transcript', transcript,
    '--query', '缓存恢复',
  ], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN_GUARD_TASK_MEMORY_DIR: stateDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /缓存恢复已经排除/);
  assert.doesNotMatch(result.stdout, /已检查导入顺序/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('search CLI fails clearly when required arguments are missing', () => {
  const root = tempDir();
  const result = spawnSync(process.execPath, [
    path.resolve('tools/codex-task-memory.mjs'),
    'search',
    '--session', 'missing-query',
  ], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN_GUARD_TASK_MEMORY_DIR: path.join(root, 'state') },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /search 需要 --query/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('installer does not overwrite malformed hooks.json', () => {
  const root = tempDir();
  const hooksFile = path.join(root, 'hooks.json');
  const original = '{"hooks": malformed';
  fs.writeFileSync(hooksFile, original);
  const result = spawnSync(process.execPath, [
    path.resolve('tools/install-codex-task-memory.mjs'),
  ], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: root },
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(hooksFile, 'utf8'), original);
  fs.rmSync(root, { recursive: true, force: true });
});

test('compaction prefers the current interactive acceptance over unrelated old rows', async () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'scope.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'scope-1', cwd: root } },
    message('user', '修复列表分组，验收是同一标题只有一个组。'),
    message('assistant', '旧问题是弹窗面板的布局错位。'),
    message('user', '把弹窗布局改好。还是没解决。'),
    { type: 'compacted', timestamp: '2026-11-06T10:04:00.000Z', payload: {} },
  ]);
  await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'scope-1',
    transcript_path: transcript,
    prompt: '同一个列表分组问题修复了 4 遍还是一样。',
  }, { stateDir });
  const result = await handleHook({
    hook_event_name: 'SessionStart',
    source: 'compact',
    session_id: 'scope-1',
    transcript_path: transcript,
  }, { stateDir });
  const context = result.output.hookSpecificOutput.additionalContext;
  assert.match(context, /同一个列表分组问题修复了 4 遍还是一样/);
  assert.doesNotMatch(context, /弹窗布局改好/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('user confirmation closes the acceptance row and resets the loop breaker', async () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'resolved.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'resolved-1', cwd: root } },
    message('user', '修复列表重复，验收是同一标题只有一个组。'),
    message('user', '还是一样，没解决。'),
    message('user', '同一个问题还是没解决。'),
  ]);
  const failed = await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'resolved-1',
    transcript_path: transcript,
  }, { stateDir });
  assert.ok(failed.state.loop.count >= 2);
  const resolved = await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'resolved-1',
    transcript_path: transcript,
    prompt: '验收通过，同一标题只有一个组了。',
  }, { stateDir });
  assert.equal(resolved.state.loop.count, 0);
  assert.ok(resolved.state.acceptance.some(item => item.status === 'user-confirmed'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('detects correction and repeated-failure language in English', async () => {
  const root = tempDir();
  const stateDir = path.join(root, 'state');
  const transcript = path.join(root, 'english.jsonl');
  writeTranscript(transcript, [
    { type: 'session_meta', payload: { session_id: 'english-1', cwd: root } },
    message('user', 'Fix duplicate records. Acceptance: each record appears once.'),
    message('assistant', 'It is probably caused by a stale cache.'),
    message('user', 'This is unrelated to cache. I already tested an empty start.'),
    message('user', 'Network retry was ruled out, but the same issue is still failing.'),
  ]);
  const result = await handleHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'english-1',
    transcript_path: transcript,
    prompt: 'Fixed 3 times and it is still broken.',
  }, { stateDir });
  assert.equal(result.state.taskKind, 'work');
  assert.ok(result.state.confirmedFacts.some(item => /unrelated to cache/i.test(item.text)));
  assert.ok(result.state.loop.count >= 2);
  assert.match(result.output.hookSpecificOutput.additionalContext, /重复失败熔断/);
  fs.rmSync(root, { recursive: true, force: true });
});
