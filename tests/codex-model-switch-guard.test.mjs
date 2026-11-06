import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BLOCK_AT_CNY,
  DEFAULT_MIN_CONTEXT_TOKENS,
  decideModelSwitch,
  deepseekPeak,
  inspectTranscript,
  outputForDecision,
  resolveModelRates,
} from '../tools/codex-model-switch-guard.mjs';

const pricing = {
  deepseek: {
    'deepseek-v4-flash': {
      input: 1,
      cachedInput: 0.02,
      output: 4,
      peak: { input: 2, cachedInput: 0.04, output: 8 },
    },
    'deepseek-v4.1-flash': {
      input: 1,
      cachedInput: 0.02,
      output: 4,
      peak: { input: 2, cachedInput: 0.04, output: 8 },
    },
    'deepseek-v4-pro': {
      input: 4.5,
      cachedInput: 0.15,
      output: 13.5,
      peak: { input: 9, cachedInput: 0.3, output: 27 },
    },
  },
};

const offPeak = '2026-10-30T10:31:16.639Z';

test('resolves the exact model and detects off-peak pricing', () => {
  assert.equal(deepseekPeak(offPeak), false);
  assert.equal(deepseekPeak('2026-10-30T01:30:00.000Z'), true);
  assert.equal(resolveModelRates(pricing, 'deepseek-v4-pro', offPeak).input, 4.5);
  assert.equal(resolveModelRates(pricing, 'custom/deepseek-v4.1-flash', offPeak).input, 1);
});

test('reproduces the 170k Flash to Pro switch as a blocking cost event', () => {
  const decision = decideModelSwitch({
    previousModel: 'deepseek-v4-flash',
    currentModel: 'deepseek-v4-pro',
    contextTokens: 170_354,
    pricing,
    at: offPeak,
  });
  assert.equal(decision.action, 'block');
  assert.equal(decision.inputMultiplier, 4.5);
  assert.ok(Math.abs(decision.firstCallInputCny - 0.766593) < 1e-9);
  assert.ok(decision.firstCallInputCny > DEFAULT_BLOCK_AT_CNY);
  const output = outputForDecision(decision);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /170,354 token/);
  assert.match(output.reason, /¥0\.77/);
});

test('small expensive-model context gets a plan instead of a block', () => {
  const decision = decideModelSwitch({
    previousModel: 'deepseek-v4-flash',
    currentModel: 'deepseek-v4-pro',
    contextTokens: 50_000,
    pricing,
    at: offPeak,
  });
  assert.equal(decision.action, 'none');
  const medium = decideModelSwitch({
    previousModel: 'deepseek-v4-flash',
    currentModel: 'deepseek-v4-pro',
    contextTokens: 90_000,
    pricing,
    at: offPeak,
  });
  assert.equal(medium.action, 'plan');
  assert.equal(medium.contextTokens > DEFAULT_MIN_CONTEXT_TOKENS, true);
  assert.match(outputForDecision(medium).hookSpecificOutput.additionalContext, /不重读已看过的文件/);
  const large = decideModelSwitch({
    previousModel: 'deepseek-v4-flash',
    currentModel: 'deepseek-v4-pro',
    contextTokens: 120_000,
    pricing,
    at: offPeak,
  });
  assert.equal(large.action, 'block');
});

test('switching to a cheaper or same-priced model does not add context', () => {
  assert.equal(decideModelSwitch({
    previousModel: 'deepseek-v4-pro',
    currentModel: 'deepseek-v4-flash',
    contextTokens: 170_000,
    pricing,
    at: offPeak,
  }).action, 'none');
  assert.equal(decideModelSwitch({
    previousModel: 'deepseek-v4-flash',
    currentModel: 'deepseek-v4.1-flash',
    contextTokens: 170_000,
    pricing,
    at: offPeak,
  }).action, 'none');
});

test('transcript inspection reads only structured model and usage fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({
      timestamp: '2026-10-30T10:30:23.736Z',
      type: 'turn_context',
      payload: { turn_id: 't1', model: 'deepseek-v4-flash', prompt: 'not used' },
    }),
    JSON.stringify({
      timestamp: '2026-10-30T10:30:33.362Z',
      type: 'token_usage_record',
      payload: {
        usage: { input_tokens: 165_912, cached_input_tokens: 165_632, output_tokens: 50 },
        text: 'not used',
      },
    }),
  ].join('\n'));
  const transcript = await inspectTranscript(file);
  assert.equal(transcript.lastModel, 'deepseek-v4-flash');
  assert.equal(transcript.inputTokens, 165_912);
  assert.equal(transcript.cachedInputTokens, 165_632);
  assert.equal(JSON.stringify(transcript).includes('not used'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
