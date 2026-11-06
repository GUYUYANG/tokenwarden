import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const auditTool = fileURLToPath(new URL('../tools/codex-session-audit.mjs', import.meta.url));

function makeRecords({
  requestChars = 247,
  calls = 50,
  commands = 100,
  mutateAfterCall = null,
} = {}) {
  const at = '2026-11-04T02:00:00.000Z';
  const records = [
    {
      timestamp: at,
      type: 'session_meta',
      payload: {
        cwd: '/tmp/token-guard-test',
        model_provider: 'wb-proxy',
        provenance: { model: 'deepseek-v4.1-flash' },
        timestamp: at,
      },
    },
    {
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'N'.repeat(4_000) }],
      },
    },
    {
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          id: 'initial-user',
          client_id: 'initial-client',
          content: [{ type: 'text', text: 'S'.repeat(requestChars) }],
        },
      },
    },
  ];

  const mutationRecords = () => [
    {
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'mutation',
        input: 'synthetic patch',
      },
    },
    {
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'mutation',
        output: 'Done',
      },
    },
  ];

  if (mutateAfterCall === 0) records.push(...mutationRecords());
  for (let i = 0; i < calls; i++) {
    if (mutateAfterCall === i && i > 0) records.push(...mutationRecords());
    records.push(
      {
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: `lookup-${i}`,
          arguments: JSON.stringify({ index: i }),
        },
      },
      {
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: `lookup-${i}`,
          output: 'short result',
        },
      },
      {
        timestamp: at,
        type: 'token_usage_record',
        payload: {
          response_id: `usage-${i}`,
          usage: {
            input_tokens: 1_000,
            cached_input_tokens: 900,
            output_tokens: 10,
          },
        },
      },
    );
  }

  for (let i = 0; i < commands; i++) {
    records.push({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', id: `command-${i}` },
      },
    });
  }

  return records;
}

function runAudit(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-audit-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  const result = spawnSync(process.execPath, [auditTool, file, '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CODEX_HOME: root },
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('flags a short lookup that exploded into commands and model round trips', () => {
  const report = runAudit(makeRecords());

  assert.ok(report.workflow.requestChars > 0);
  assert.ok(report.workflow.requestChars < 600);
  assert.ok(report.workflow.allUserMessageChars > report.workflow.requestChars);
  assert.equal(report.workflow.preMutationModelCalls, 50);
  assert.equal(report.workflow.preMutationCommandEvents, 100);
  assert.equal(report.workflow.commandEvents, 100);
  assert.equal(report.workflow.mutatingCalls, 0);
  assert.equal(report.workflow.simpleQueryOverhead, true);
  assert.ok(report.findings.some(item => item.code === 'simple-query-overhead'));
  assert.ok(report.recommendations.some(item => item.includes('并行检索')));
  assert.equal(JSON.stringify(report).includes('S'.repeat(50)), false);
});

test('does not flag a bounded short lookup', () => {
  const report = runAudit(makeRecords({ calls: 8, commands: 12 }));

  assert.equal(report.workflow.lowComplexityRequest, true);
  assert.equal(report.workflow.simpleQueryOverhead, false);
  assert.equal(report.findings.some(item => item.code === 'simple-query-overhead'), false);
});

test('does not classify a mutation workflow as a simple query', () => {
  const report = runAudit(makeRecords({ mutateAfterCall: 0 }));

  assert.equal(report.workflow.mutatingCalls, 1);
  assert.equal(report.workflow.simpleQueryOverhead, false);
  assert.equal(report.findings.some(item => item.code === 'simple-query-overhead'), false);
});

test('does not count work after the first real mutation as part of the query phase', () => {
  const report = runAudit(makeRecords({ mutateAfterCall: 5 }));

  assert.equal(report.workflow.mutatingCalls, 1);
  assert.equal(report.workflow.preMutationModelCalls, 5);
  assert.equal(report.workflow.preMutationCommandEvents, 0);
  assert.equal(report.workflow.simpleQueryOverhead, false);
});
