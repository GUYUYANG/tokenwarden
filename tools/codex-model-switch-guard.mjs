#!/usr/bin/env node
// Codex model-switch budget guard. It reads the official hook JSON from stdin,
// inspects structured token telemetry, and never logs prompt or transcript text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const STATE_DIR = path.join(CODEX_HOME, 'tokenwarden');
const STATE_FILE = path.join(STATE_DIR, 'model-switch-state.json');
const EVENT_LOG = path.join(STATE_DIR, 'model-switch-events.jsonl');

export const DEFAULT_MIN_CONTEXT_TOKENS = 80_000;
export const DEFAULT_BLOCK_AT_CNY = 0.5;

const BUILTIN_DEEPSEEK_PRICING = {
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
  'deepseek-flash': {
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
};

const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function readBooleanEnv(name, fallback) {
  const value = process.env[name] ?? process.env[`TOKEN_GUARD_${name.replace(/^TOKENWARDEN_/, '')}`];
  if (value === undefined) return fallback;
  return !/^(0|false|off|no)$/i.test(value);
}

function positiveNumberEnv(name, fallback) {
  const legacyName = `TOKEN_GUARD_${name.replace(/^TOKENWARDEN_/, '')}`;
  const value = Number(process.env[name] ?? process.env[legacyName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: 1, sessions: {}, blocked: {} };
  }
}

function writeState(state) {
  ensureStateDir();
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, STATE_FILE);
}

function recordEvent(entry) {
  try {
    ensureStateDir();
    fs.appendFileSync(EVENT_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
    })}\n`);
  } catch {}
}

function formatInteger(value) {
  return Math.round(number(value)).toLocaleString('zh-CN');
}

function formatMoney(value) {
  return `¥${Number(value).toFixed(2)}`;
}

export function deepseekPeak(timestamp) {
  const epochMs = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(epochMs) || epochMs < Date.parse('2026-08-01T00:00:00Z')) return false;
  const date = new Date(epochMs);
  const beijing = new Date(epochMs + 8 * 3600_000);
  const day = beijing.getUTCDay();
  const dateKey = beijing.toISOString().slice(0, 10);
  if (day === 0 || day === 6 || HOLIDAYS.has(dateKey)) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function resolveModelRates(pricing, model, at = new Date().toISOString()) {
  const normalized = String(model || '').toLowerCase();
  if (!normalized) return null;
  const table = pricing?.deepseek || {};
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find(candidate => normalized.includes(candidate));
  const entry = key ? table[key] : null;
  if (!entry) return null;
  return deepseekPeak(at) ? entry.peak || entry : entry.offPeak || entry;
}

function loadPricing() {
  const envCommand = process.env.TOKENWARDEN_COST_METER_COMMAND
    || process.env.TOKEN_GUARD_COST_METER_COMMAND;
  const command = envCommand || 'codex-cost-meter';
  const result = spawnSync(command, ['prices', '--json'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 2_500,
    maxBuffer: 2 * 1024 * 1024,
    shell: Boolean(envCommand),
  });
  if (!result.error && result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed?.deepseek) return parsed;
    } catch {}
  }
  return { currency: 'CNY', deepseek: BUILTIN_DEEPSEEK_PRICING, source: 'builtin' };
}

function usageFromRecord(record) {
  const payload = record?.payload || {};
  if (record?.type === 'token_usage_record' && payload.usage) return payload.usage;
  if (record?.type === 'event_msg' && payload.type === 'token_count') {
    return payload.info?.last_token_usage || null;
  }
  return null;
}

function compactAtFromRecord(record) {
  const type = `${record?.type || ''}/${record?.payload?.type || ''}`;
  return /compact/i.test(type) ? record?.timestamp || null : null;
}

export async function inspectTranscript(file) {
  const result = {
    lastModel: '',
    previousModel: '',
    models: [],
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    lastUsageAt: null,
    lastCompactAt: null,
  };
  if (!file || !fs.existsSync(file)) return result;

  try {
    const lines = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line || (
        !line.includes('"turn_context"') &&
        !line.includes('"token_usage_record"') &&
        !line.includes('"token_count"') &&
        !line.includes('compact')
      )) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === 'turn_context' && record.payload?.model) {
        const model = String(record.payload.model);
        if (result.models.at(-1) !== model) result.models.push(model);
        result.lastModel = model;
      }
      const usage = usageFromRecord(record);
      if (usage) {
        result.inputTokens = number(usage.input_tokens);
        result.cachedInputTokens = number(usage.cached_input_tokens);
        result.outputTokens = number(usage.output_tokens);
        result.lastUsageAt = record.timestamp || new Date().toISOString();
      }
      const compactAt = compactAtFromRecord(record);
      if (compactAt && (!result.lastCompactAt || compactAt > result.lastCompactAt)) {
        result.lastCompactAt = compactAt;
      }
    }
  } catch {}

  if (result.models.length > 1) {
    result.previousModel = result.models.at(-2);
  }
  return result;
}

export function previousModelFor(currentModel, stateEntry, transcript) {
  const stored = stateEntry?.lastModel;
  if (stored && stored !== currentModel) return stored;
  if (stored === currentModel) return currentModel;
  const transcriptModel = transcript?.lastModel;
  if (transcriptModel && transcriptModel !== currentModel) return transcriptModel;
  return transcript?.previousModel || transcriptModel || '';
}

export function decideModelSwitch({
  previousModel,
  currentModel,
  contextTokens,
  pricing,
  at = new Date().toISOString(),
  minContextTokens = DEFAULT_MIN_CONTEXT_TOKENS,
  blockAtCny = DEFAULT_BLOCK_AT_CNY,
}) {
  if (!previousModel || !currentModel || previousModel === currentModel) {
    return { action: 'none', reason: 'same-model' };
  }
  const tokens = number(contextTokens);
  if (tokens < minContextTokens) {
    return { action: 'none', reason: 'below-context-threshold', contextTokens: tokens };
  }

  const previousRates = resolveModelRates(pricing, previousModel, at);
  const currentRates = resolveModelRates(pricing, currentModel, at);
  if (!previousRates || !currentRates) {
    return {
      action: 'none',
      reason: 'unpriced-model',
      contextTokens: tokens,
      previousModel,
      currentModel,
    };
  }

  const inputMultiplier = currentRates.input / Math.max(previousRates.input, Number.EPSILON);
  if (inputMultiplier < 1.25) {
    return {
      action: 'none',
      reason: inputMultiplier < 0.8 ? 'cheaper-model' : 'similar-price',
      contextTokens: tokens,
      inputMultiplier,
    };
  }

  const firstCallInputCny = tokens * number(currentRates.input) / 1_000_000;
  const result = {
    action: firstCallInputCny >= blockAtCny ? 'block' : 'plan',
    reason: firstCallInputCny >= blockAtCny ? 'switch-cost-above-cap' : 'cost-aware-plan',
    previousModel,
    currentModel,
    contextTokens: tokens,
    inputMultiplier,
    firstCallInputCny,
    minContextTokens,
    blockAtCny,
  };
  return result;
}

export function outputForDecision(decision, targetContextTokens = 100_000) {
  if (decision.action === 'none') return null;
  if (decision.action === 'block') {
    return {
      decision: 'block',
      reason: [
        `Token Guard：模型已从 ${decision.previousModel} 切换到 ${decision.currentModel}。`,
        `当前上下文约 ${formatInteger(decision.contextTokens)} token，切换后的首次调用需要重建缓存，`,
        `仅输入预计 ${formatMoney(decision.firstCallInputCny)}（新模型单价约为旧的 ${decision.inputMultiplier.toFixed(1)} 倍），`,
        `超过切换阈值 ${formatMoney(decision.blockAtCny)}。`,
        `请先 /compact 到约 ${formatInteger(targetContextTokens)} token 以内再重发，或让旧模型写一份简短交接后新开任务。`,
      ].join(''),
    };
  }
  const additionalContext = [
    `Token Guard 模型切换预算：${decision.previousModel} → ${decision.currentModel}，`,
    `现有上下文约 ${formatInteger(decision.contextTokens)} token，首次全价输入预计 ${formatMoney(decision.firstCallInputCny)}。`,
    '本轮执行计划：复用已有结论，不重读已看过的文件；把独立检查合并为 1–2 批；',
    '命令和 MCP 只取关键片段；批量编辑完成后再统一验证；',
    '除非任务确实需要，不启动子代理、不重复附加大图；最终只给结论、必要差异和验证结果。',
    '如果目标已经变化，先写简短交接并建议新开任务。',
  ].join('');
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

function switchKey(sessionId, decision) {
  return [
    sessionId,
    decision.previousModel,
    decision.currentModel,
    decision.contextTokens,
  ].join('|');
}

export async function handleHook(input, options = {}) {
  const event = input?.hook_event_name;
  const sessionId = String(input?.session_id || '');
  const currentModel = String(input?.model || '');
  if (!sessionId || !currentModel) {
    return { output: null, event: null };
  }

  const state = options.state || readState();
  const transcript = await inspectTranscript(input.transcript_path);
  const previousState = state.sessions?.[sessionId] || {};
  const usageIsFresh = transcript.lastUsageAt && (!previousState.usageAt || transcript.lastUsageAt > previousState.usageAt);
  const compactIsFresh = transcript.lastCompactAt &&
    (!transcript.lastUsageAt || transcript.lastCompactAt > transcript.lastUsageAt);
  const contextTokens = usageIsFresh
    ? transcript.inputTokens
    : previousState.inputTokens ?? transcript.inputTokens;

  if (event === 'Stop') {
    state.sessions ||= {};
    state.sessions[sessionId] = {
      lastModel: currentModel,
      inputTokens: usageIsFresh ? transcript.inputTokens : previousState.inputTokens ?? transcript.inputTokens,
      cachedInputTokens: usageIsFresh ? transcript.cachedInputTokens : previousState.cachedInputTokens,
      outputTokens: usageIsFresh ? transcript.outputTokens : previousState.outputTokens,
      usageAt: usageIsFresh ? transcript.lastUsageAt : previousState.usageAt,
      updatedAt: new Date().toISOString(),
    };
    writeState(state);
    return { output: null, event: null };
  }

  if (event !== 'UserPromptSubmit') return { output: null, event: null };

  const previousModel = previousModelFor(currentModel, previousState, transcript);
  const pricing = options.pricing || loadPricing();
  const decision = decideModelSwitch({
    previousModel,
    currentModel,
    contextTokens: compactIsFresh ? null : contextTokens,
    pricing,
    at: input.timestamp || new Date().toISOString(),
    minContextTokens: options.minContextTokens ?? positiveNumberEnv(
      'TOKENWARDEN_MODEL_SWITCH_MIN_CONTEXT',
      DEFAULT_MIN_CONTEXT_TOKENS,
    ),
    blockAtCny: options.blockAtCny ?? positiveNumberEnv(
      'TOKENWARDEN_MODEL_SWITCH_BLOCK_CNY',
      DEFAULT_BLOCK_AT_CNY,
    ),
  });

  const key = switchKey(sessionId, decision);
  if (decision.action === 'none') return { output: null, decision, transcript };
  if (decision.action === 'plan' && previousState.lastNoticeKey === key) {
    return { output: null, decision: { ...decision, action: 'none', reason: 'already-notified' }, transcript };
  }

  if (decision.action === 'plan') {
    state.sessions ||= {};
    state.sessions[sessionId] = {
      ...previousState,
      lastNoticeKey: key,
      updatedAt: new Date().toISOString(),
    };
    writeState(state);
  }

  recordEvent({
    event: 'model-switch',
    sessionId,
    previousModel: decision.previousModel,
    currentModel: decision.currentModel,
    contextTokens: decision.contextTokens,
    inputMultiplier: Number(decision.inputMultiplier.toFixed(3)),
    estimatedFirstCallInputCny: Number(decision.firstCallInputCny.toFixed(6)),
    action: decision.action,
    reason: decision.reason,
  });
  return { output: outputForDecision(decision), decision, transcript };
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function main() {
  if (!readBooleanEnv('TOKENWARDEN_MODEL_SWITCH', true)) return;
  let input;
  try {
    input = await readStdin();
  } catch {
    process.exitCode = 2;
    return;
  }
  try {
    const result = await handleHook(input);
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } catch (error) {
    recordEvent({
      event: 'guard-error',
      sessionId: String(input?.session_id || ''),
      error: String(error?.message || error),
    });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
