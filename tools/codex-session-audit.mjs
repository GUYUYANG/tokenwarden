#!/usr/bin/env node
// Codex 高花费会话审计。只读 token 遥测和结构化元数据，不输出对话正文。
// 用法:
//   node tools/codex-session-audit.mjs <session-id|rollout.jsonl> [--threshold 200000] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const DEFAULT_THRESHOLD = 200_000;
const DEFAULT_TOP = 10;
const SIMPLE_QUERY_MAX_REQUEST_CHARS = 600;
const SIMPLE_QUERY_MIN_MODEL_CALLS = 40;
const SIMPLE_QUERY_MIN_COMMAND_EVENTS = 80;
const MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'write',
  'write_file',
  'edit',
  'edit_file',
  'patch',
  'patch_file',
  'delete',
  'delete_file',
  'remove',
  'remove_file',
  'move',
  'move_file',
  'rename',
  'rename_file',
  'create',
  'create_file',
  'replace',
  'replace_file',
  'install',
  'install_skill',
]);
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);

function usage() {
  console.log(`Codex session audit

Usage:
  node tools/codex-session-audit.mjs <session-id|session.jsonl> [options]

Options:
  --threshold N    Context threshold in tokens (default: ${DEFAULT_THRESHOLD})
  --top N          Number of large output groups to show (default: ${DEFAULT_TOP})
  --json           Print machine-readable JSON
  --include-title  Include the local session title (redacted by default)
  --help            Show this help

The report reads local Codex rollout telemetry only. It never prints prompts,
assistant text, reasoning text, tool arguments, or raw tool output.`);
}

function parseArgs(argv) {
  const options = {
    target: '',
    threshold: DEFAULT_THRESHOLD,
    top: DEFAULT_TOP,
    json: false,
    includeTitle: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--include-title') options.includeTitle = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--threshold') options.threshold = positiveInt(argv[++i], '--threshold');
    else if (arg === '--top') options.top = positiveInt(argv[++i], '--top');
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.target) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function walkFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) result.push(full);
    }
  }
  return result.sort();
}

function resolveSessionFile(target) {
  if (!target) throw new Error('A session ID or rollout JSONL path is required');
  const candidate = path.resolve(target);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  const matches = walkFiles(path.join(CODEX_HOME, 'sessions'))
    .filter(file => path.basename(file).includes(target));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Session target is ambiguous (${matches.length} matches): ${target}`);
  throw new Error(`Session not found: ${target}`);
}

function sessionIdFromPath(file) {
  return path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i)?.[1] || '';
}

async function eachLine(file, callback) {
  let stream = fs.createReadStream(file);
  if (file.endsWith('.zst')) {
    const decoder = zlib.createZstdDecompress();
    decoder.on('error', error => stream.destroy(error));
    stream = stream.pipe(decoder);
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let ordinal = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      callback(JSON.parse(line), ordinal++);
    } catch {
      // A live rollout can end with a torn line. Ignore only the unreadable record.
    }
  }
}

function titleFor(sessionId) {
  const file = path.join(CODEX_HOME, 'session_index.jsonl');
  if (!fs.existsSync(file)) return '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const item = JSON.parse(line);
      if (item.id === sessionId) return item.thread_name || '';
    } catch {}
  }
  return '';
}

function currentCompactConfig() {
  const file = path.join(CODEX_HOME, 'config.toml');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^\s*model_auto_compact_token_limit\s*=\s*(\d+)\s*$/m);
    return {
      path: file,
      threshold: match ? Number(match[1]) : null,
      modifiedAt: fs.statSync(file).mtime.toISOString(),
    };
  } catch {
    return { path: file, threshold: null, modifiedAt: null };
  }
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    timeout: 20_000,
  });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function readPricing() {
  return runJson('codex-cost-meter', ['prices', '--json']);
}

function readCostReport(sessionId) {
  if (!sessionId) return null;
  return runJson('codex-cost-meter', [
    'report',
    '--session', sessionId,
    '--period', 'all',
    '--json',
  ]);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function deepseekPeak(timestamp) {
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

function modelRates(pricing, model, at) {
  if (!pricing?.deepseek) return null;
  const normalized = String(model || '').toLowerCase();
  const keys = Object.keys(pricing.deepseek).sort((a, b) => b.length - a.length);
  const key = keys.find(candidate => normalized.includes(candidate));
  const entry = key ? pricing.deepseek[key] : null;
  if (!entry) return null;
  return deepseekPeak(Date.parse(at)) ? entry.peak || entry : entry.offPeak || entry;
}

function rowCost(usage, rates) {
  if (!rates) return null;
  const input = number(usage.input_tokens);
  const cached = Math.min(input, number(usage.cached_input_tokens));
  const miss = Math.max(0, input - cached);
  const output = number(usage.output_tokens);
  const missCost = miss * number(rates.input) / 1_000_000;
  const cachedCost = cached * number(rates.cachedInput) / 1_000_000;
  const outputCost = output * number(rates.output) / 1_000_000;
  return {
    cacheMiss: missCost,
    cachedInput: cachedCost,
    output: outputCost,
    total: missCost + cachedCost + outputCost,
  };
}

function emptyUsage() {
  return { calls: 0, input: 0, cacheMiss: 0, cached: 0, output: 0, reasoning: 0 };
}

function addUsage(total, usage) {
  const input = number(usage.input_tokens);
  const cached = Math.min(input, number(usage.cached_input_tokens));
  total.calls += 1;
  total.input += input;
  total.cached += cached;
  total.cacheMiss += input - cached;
  total.output += number(usage.output_tokens);
  total.reasoning += number(usage.reasoning_output_tokens);
}

function addMapStats(map, key, chars) {
  const item = map.get(key) || { count: 0, chars: 0, maxChars: 0 };
  item.count += 1;
  item.chars += chars;
  item.maxChars = Math.max(item.maxChars, chars);
  map.set(key, item);
}

function textSize(value) {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
}

function isMutationTool(name) {
  const normalized = String(name || '').toLowerCase();
  const leaf = normalized.split(/__|[/:]/).filter(Boolean).at(-1) || normalized;
  return MUTATION_TOOL_NAMES.has(normalized) || MUTATION_TOOL_NAMES.has(leaf);
}

function formatNumber(value) {
  const n = number(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function money(value, currency = 'CNY') {
  if (value === null || value === undefined) return 'n/a';
  return `${currency === 'CNY' ? '¥' : ''}${Number(value).toFixed(4)}`;
}

async function analyze(file, options) {
  const pathSessionId = sessionIdFromPath(file);
  const meta = {
    sessionId: pathSessionId,
    cwd: '',
    model: '',
    provider: '',
    startedAt: null,
    endedAt: null,
  };
  const turnOrder = [];
  const turnAt = new Map();
  const usageRows = [];
  const contextSamples = [];
  const compactionTypes = new Map();
  const toolStats = new Map();
  const outputGroups = new Map();
  const outputByCall = new Map();
  const callByHash = new Map();
  const duplicateCalls = [];
  const contentStats = {
    userMessageChars: 0,
    initialUserMessageChars: 0,
    userMessageCount: 0,
    developerMessageChars: 0,
    inputImages: 0,
    inputImageChars: 0,
  };
  const itemStats = new Map();
  const commandEventOrdinals = [];
  const compactionOrdinals = [];
  let firstResponseUserMessageChars = null;
  let firstMutationOrdinal = null;
  let firstMutationTool = '';
  let messageOrdinal = 0;

  await eachLine(file, (record, ordinal) => {
    const payload = record.payload || {};
    const at = record.timestamp || new Date().toISOString();
    meta.endedAt = at;
    const recordType = `${record.type || 'unknown'}/${payload.type || ''}`;
    if (/compact/i.test(recordType)) {
      addMapStats(compactionTypes, recordType, 0);
      compactionOrdinals.push(ordinal);
    }

    if (record.type === 'session_meta') {
      meta.sessionId = payload.session_id || payload.id || meta.sessionId;
      meta.cwd = payload.cwd || meta.cwd;
      meta.model = payload.provenance?.model || meta.model;
      meta.provider = payload.model_provider || meta.provider;
      meta.startedAt = payload.timestamp || at;
      return;
    }

    if (record.type === 'turn_context') {
      const turnId = payload.turn_id;
      if (turnId && !turnAt.has(turnId)) turnOrder.push(turnId);
      if (turnId) turnAt.set(turnId, at);
      meta.model = payload.model || meta.model;
      meta.provider = payload.model_provider || meta.provider;
      return;
    }

    if (record.type === 'token_usage_record' && payload.usage) {
      usageRows.push({
        key: payload.response_id || `usage-${ordinal}`,
        ordinal,
        at,
        turnId: payload.turn_id || '',
        model: meta.model,
        usage: payload.usage,
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'token_count') {
      const usage = payload.info?.last_token_usage;
      if (usage) contextSamples.push({ at, usage });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'item_completed' && payload.item?.type) {
      addMapStats(itemStats, payload.item.type, textSize(payload.item));
      if (payload.item.type === 'UserMessage') {
        contentStats.userMessageCount += 1;
        if (!contentStats.initialUserMessageChars) {
          contentStats.initialUserMessageChars = textSize(payload.item);
        }
      }
      if (payload.item.type === 'CommandExecution') commandEventOrdinals.push(ordinal);
      return;
    }

    if (record.type !== 'response_item') return;
    const type = payload.type;
    if (type === 'message') {
      const role = payload.role || '';
      let userTextChars = 0;
      for (const part of payload.content || []) {
        if (part?.type === 'input_text') {
          if (role === 'user') {
            const chars = textSize(part.text);
            contentStats.userMessageChars += chars;
            userTextChars += chars;
          }
          if (role === 'developer') contentStats.developerMessageChars += textSize(part.text);
        }
        if (part?.type === 'input_image') {
          contentStats.inputImages += 1;
          contentStats.inputImageChars += textSize(part.image_url || part.image);
        }
      }
      if (role === 'user' && firstResponseUserMessageChars === null) {
        firstResponseUserMessageChars = userTextChars;
      }
      messageOrdinal += 1;
      return;
    }

    if (type === 'function_call' || type === 'custom_tool_call') {
      const name = payload.name || '(unnamed)';
      const rawArgs = payload.arguments ?? payload.input ?? '';
      const keyHash = crypto.createHash('sha1').update(`${name}\0${rawArgs}`).digest('hex');
      const call = { id: payload.call_id || '', name, keyHash, at };
      if (firstMutationOrdinal === null && isMutationTool(name)) {
        firstMutationOrdinal = ordinal;
        firstMutationTool = name;
      }
      addMapStats(toolStats, name, 0);
      if (call.id) outputByCall.set(call.id, call);
      if (callByHash.has(keyHash)) {
        duplicateCalls.push({ name, at, previousAt: callByHash.get(keyHash) });
      } else {
        callByHash.set(keyHash, at);
      }
      return;
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const call = outputByCall.get(payload.call_id);
      const key = call?.keyHash || `unknown-${payload.call_id || messageOrdinal++}`;
      const name = call?.name || '(unknown)';
      addMapStats(outputGroups, key, textSize(payload.output));
      const group = outputGroups.get(key);
      group.name = name;
      group.lastAt = at;
      const tool = toolStats.get(name);
      if (tool) {
        tool.chars += textSize(payload.output);
        tool.maxChars = Math.max(tool.maxChars, textSize(payload.output));
      }
    }
  });

  const uniqueUsage = [...new Map(usageRows.map(row => [row.key, row])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const workflowBoundaryOrdinal = firstMutationOrdinal ?? Number.POSITIVE_INFINITY;
  const preMutationUsage = uniqueUsage.filter(row => row.ordinal < workflowBoundaryOrdinal);
  const preMutationCommandEvents = commandEventOrdinals.filter(
    ordinal => ordinal < workflowBoundaryOrdinal
  ).length;
  const preMutationCompactions = compactionOrdinals.filter(
    ordinal => ordinal < workflowBoundaryOrdinal
  ).length;
  const initialUserMessageChars = contentStats.initialUserMessageChars ||
    firstResponseUserMessageChars ||
    0;
  const usage = emptyUsage();
  for (const row of uniqueUsage) addUsage(usage, row.usage);
  usage.cacheHitRate = usage.input ? usage.cached / usage.input * 100 : 0;

  const samples = contextSamples.length
    ? contextSamples
    : uniqueUsage.map(row => ({ at: row.at, usage: row.usage }));
  const context = {
    samples: samples.length,
    peakInputTokens: 0,
    peakAt: null,
    averageInputTokens: 0,
    overThresholdCalls: 0,
    inputTokensOnOverThresholdCalls: 0,
    overThresholdInputShare: 0,
    excessInputTokens: 0,
    sampledInputTokens: 0,
  };
  for (const sample of samples) {
    const input = number(sample.usage.input_tokens);
    context.sampledInputTokens += input;
    if (input > context.peakInputTokens) {
      context.peakInputTokens = input;
      context.peakAt = sample.at;
    }
    if (input > options.threshold) {
      context.overThresholdCalls += 1;
      context.inputTokensOnOverThresholdCalls += input;
      context.excessInputTokens += input - options.threshold;
    }
  }
  context.averageInputTokens = context.samples ? context.sampledInputTokens / context.samples : 0;
  context.overThresholdInputShare = context.sampledInputTokens
    ? context.inputTokensOnOverThresholdCalls / context.sampledInputTokens * 100
    : 0;

  const pricing = readPricing();
  const costComponents = { cacheMiss: 0, cachedInput: 0, output: 0, total: 0, pricedCalls: 0 };
  for (const row of uniqueUsage) {
    const rates = modelRates(pricing, row.model || meta.model, row.at);
    const cost = rowCost(row.usage, rates);
    if (!cost) continue;
    costComponents.cacheMiss += cost.cacheMiss;
    costComponents.cachedInput += cost.cachedInput;
    costComponents.output += cost.output;
    costComponents.total += cost.total;
    costComponents.pricedCalls += 1;
  }

  const uniqueModels = [...new Set(uniqueUsage.map(row => row.model || meta.model).filter(Boolean))];
  let excessInputCost = null;
  if (uniqueModels.length === 1) {
    excessInputCost = 0;
    for (const sample of samples) {
      const input = number(sample.usage.input_tokens);
      const over = Math.max(0, input - options.threshold);
      if (!over) continue;
      const cached = Math.min(input, number(sample.usage.cached_input_tokens));
      const cachedShare = input ? cached / input : 0;
      const rates = modelRates(pricing, uniqueModels[0], sample.at);
      if (!rates) {
        excessInputCost = null;
        break;
      }
      excessInputCost += over * (
        (1 - cachedShare) * number(rates.input) +
        cachedShare * number(rates.cachedInput)
      ) / 1_000_000;
    }
  }

  const turns = turnOrder.map((turnId, index) => {
    const rows = uniqueUsage.filter(row => row.turnId === turnId);
    const sum = emptyUsage();
    let turnCost = 0;
    let pricedCalls = 0;
    for (const row of rows) {
      addUsage(sum, row.usage);
      const rates = modelRates(pricing, row.model || meta.model, row.at);
      const cost = rowCost(row.usage, rates);
      if (cost) {
        turnCost += cost.total;
        pricedCalls += 1;
      }
    }
    return {
      index: index + 1,
      turnId,
      startedAt: turnAt.get(turnId),
      calls: sum.calls,
      cost: pricedCalls ? turnCost : null,
      input: sum.input,
      cached: sum.cached,
      output: sum.output,
      firstInput: rows[0] ? number(rows[0].usage.input_tokens) : 0,
      lastInput: rows.at(-1) ? number(rows.at(-1).usage.input_tokens) : 0,
      peakInput: rows.reduce((max, row) => Math.max(max, number(row.usage.input_tokens)), 0),
    };
  });

  const toolRanking = [...toolStats].map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.chars - a.chars || b.count - a.count);
  const outputRanking = [...outputGroups.values()]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, options.top)
    .map(item => ({
      name: item.name || '(unknown)',
      count: item.count,
      outputChars: item.chars,
      maxOutputChars: item.maxChars,
    }));
  const duplicateGroups = [...outputGroups.values()].filter(item => item.count > 1);
  const duplicateCount = duplicateGroups.reduce((sum, item) => sum + item.count - 1, 0);
  const repeatedOutputChars = duplicateGroups.reduce(
    (sum, item) => sum + item.chars - item.chars / item.count,
    0,
  );
  const itemRanking = [...itemStats].map(([type, stats]) => ({ type, ...stats }))
    .sort((a, b) => b.chars - a.chars);
  const compactionCount = itemRanking.find(
    item => item.type === 'ContextCompaction'
  )?.count ?? 0;
  const commandEvents = itemRanking.find(
    item => item.type === 'CommandExecution'
  )?.count ?? 0;
  const mutatingCalls = toolRanking
    .filter(item => isMutationTool(item.name))
    .reduce((sum, item) => sum + item.count, 0);
  const lowComplexityRequest = initialUserMessageChars > 0 &&
    initialUserMessageChars <= SIMPLE_QUERY_MAX_REQUEST_CHARS;
  const preMutationModelCalls = preMutationUsage.length;
  const simpleQueryOverhead = lowComplexityRequest &&
    preMutationModelCalls >= SIMPLE_QUERY_MIN_MODEL_CALLS &&
    preMutationCommandEvents >= SIMPLE_QUERY_MIN_COMMAND_EVENTS;

  const config = currentCompactConfig();
  const costReport = readCostReport(meta.sessionId);
  const costSession = costReport?.sessions?.find(item => item.id === meta.sessionId);
  const title = options.includeTitle
    ? costSession?.title || titleFor(meta.sessionId)
    : '';
  const sessionStartMs = Date.parse(meta.startedAt);
  const configModifiedMs = Date.parse(config.modifiedAt);
  const configChangedDuringSession = Number.isFinite(sessionStartMs) &&
    Number.isFinite(configModifiedMs) &&
    configModifiedMs >= sessionStartMs;

  const findings = [];
  if (context.overThresholdInputShare >= 50) {
    findings.push({
      code: 'context-replay',
      severity: 'high',
      message: `${context.overThresholdCalls}/${context.samples} 次样本超过 ${formatNumber(options.threshold)}；超阈值上下文占采样输入的 ${context.overThresholdInputShare.toFixed(1)}%。`,
    });
  }
  if (compactionTypes.size === 0 && context.overThresholdCalls > 0) {
    findings.push({
      code: 'compaction-not-observed',
      severity: 'high',
      message: '事件类型字段中未观察到压缩事件，上下文持续增长。',
    });
  }
  if (compactionCount >= 3 && context.peakInputTokens < options.threshold) {
    findings.push({
      code: 'frequent-compaction',
      severity: 'warn',
      message: `发生 ${compactionCount} 次上下文压缩，但峰值仅 ${formatNumber(context.peakInputTokens)}；压缩后的上下文重建与额外往返会放大长任务耗时。`,
    });
  }
  if (simpleQueryOverhead) {
    findings.push({
      code: 'simple-query-overhead',
      severity: 'high',
      message: `初始请求仅 ${initialUserMessageChars} 字符；首次真实修改工具前已产生 ${preMutationModelCalls} 次模型调用和 ${preMutationCommandEvents} 个命令事件。简单查询被执行成了复杂调查流程。`,
    });
  }
  if (configChangedDuringSession) {
    findings.push({
      code: 'config-changed-during-session',
      severity: 'warn',
      message: 'Codex 配置文件在该会话开始后又被修改；运行中的会话不能把所有新配置当作已经加载。',
    });
  }
  if (usage.calls >= 100) {
    findings.push({
      code: 'many-model-calls',
      severity: 'warn',
      message: `${usage.calls} 次模型调用；每次调用都会重新携带当前上下文。`,
    });
  }
  if (duplicateCount > 0) {
    findings.push({
      code: 'repeated-tool-calls',
      severity: 'warn',
      message: `发现 ${duplicateCount} 次完全相同的重复工具调用；对应输出重复进入上下文的字符数约 ${formatNumber(repeatedOutputChars)}。`,
    });
  }
  if (contentStats.inputImageChars >= 200_000) {
    findings.push({
      code: 'large-image-input',
      severity: 'warn',
      message: `${contentStats.inputImages} 张输入图片共 ${formatNumber(contentStats.inputImageChars)} 字符编码；截图应裁剪、缩放并避免重复附带。`,
    });
  }

  const recommendations = [];
  if (simpleQueryOverhead) {
    recommendations.push('识别为简单查询后，先并行检索 2–4 个独立来源并只提取命中片段；默认用一个交叉核对回合收口。除非证据冲突或用户要求改动，不进入批量命令、文件修改和构建验证流程。');
  }
  if (context.overThresholdCalls > 0) {
    recommendations.push('在新会话开始前确认 model_auto_compact_token_limit 已加载；修改配置后重启 Codex，再观察首个超过阈值的回合是否被压缩。');
  }
  if (usage.calls >= 100 || duplicateCount > 5) {
    recommendations.push('把独立读取、编辑和验证合并为批次；同一条检查在文件变化前复用结果，避免重复跑命令。');
  }
  if (compactionCount >= 3) {
    recommendations.push('检查模型压缩阈值是否误伤支持视觉的模型，并减少在同一会话中反复展开、压缩同一批上下文。');
  }
  if (toolRanking.some(item => item.maxChars >= 15_000)) {
    recommendations.push('命令、构建和 MCP 输出只取所需片段或头尾，禁止把大段日志持续留在上下文中。');
  }
  if (contentStats.inputImages > 0) {
    recommendations.push('截图先裁剪到关键区域并限制数量；同一图片不要在后续回合重复上传。');
  }
  if (recommendations.length === 0) {
    recommendations.push('未发现明显结构性浪费；若仍需降费，优先拆小任务并减少模型往返次数。');
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'Codex local rollout telemetry',
    privacy: 'No prompt, assistant, reasoning, tool argument, or raw tool output text is included.',
    file,
    session: {
      id: meta.sessionId,
      title,
      cwd: meta.cwd,
      model: uniqueModels.join(', ') || meta.model,
      provider: meta.provider,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
    },
    threshold: options.threshold,
    usage,
    cost: {
      recordedEstimate: costSession?.cost ?? null,
      currency: costReport?.currency || pricing?.currency || 'CNY',
      components: costComponents.total > 0 ? costComponents : null,
      counterfactualExcessInputCost: excessInputCost,
    },
    context,
    turns,
    tools: {
      ranking: toolRanking,
      largestOutputGroups: outputRanking,
      duplicateCalls: duplicateCount,
      repeatedOutputChars: Math.round(repeatedOutputChars),
    },
    content: contentStats,
    workflow: {
      requestChars: initialUserMessageChars,
      initialUserMessageChars,
      allUserMessageChars: contentStats.userMessageChars,
      userMessageCount: contentStats.userMessageCount,
      lowComplexityRequest,
      commandEvents,
      preMutationModelCalls,
      preMutationCommandEvents,
      preMutationCompactions,
      firstMutationTool,
      mutatingCalls,
      simpleQueryOverhead,
    },
    itemTypes: itemRanking,
    config,
    configChangedDuringSession,
    compactionTypes: [...compactionTypes.keys()],
    compactionCount,
    findings,
    recommendations,
  };
}

function printReport(report) {
  const c = report.cost.components;
  console.log(`会话: ${report.session.title || '(untitled)'}`);
  console.log(`ID: ${report.session.id}`);
  console.log(`目录: ${report.session.cwd || '(unknown)'}`);
  console.log(`模型: ${report.session.model || '(unknown)'}  时间: ${report.session.startedAt} → ${report.session.endedAt}`);
  console.log('');
  console.log(`本地估算费用: ${money(report.cost.recordedEstimate, report.cost.currency)}  调用: ${report.usage.calls}`);
  console.log(`输入 ${formatNumber(report.usage.input)} (缓存 ${formatNumber(report.usage.cached)}, 未缓存 ${formatNumber(report.usage.cacheMiss)})  输出 ${formatNumber(report.usage.output)}  缓存率 ${report.usage.cacheHitRate.toFixed(2)}%`);
  if (c) {
    console.log(`费用构成: 缓存上下文 ${money(c.cachedInput, report.cost.currency)} / 未缓存输入 ${money(c.cacheMiss, report.cost.currency)} / 输出 ${money(c.output, report.cost.currency)}`);
  }
  console.log('');
  console.log(`上下文: 均值 ${formatNumber(report.context.averageInputTokens)}  峰值 ${formatNumber(report.context.peakInputTokens)}`);
  console.log(`超阈值: ${report.context.overThresholdCalls}/${report.context.samples} 次；这些调用占 ${report.context.overThresholdInputShare.toFixed(1)}% 采样输入，超出部分 ${formatNumber(report.context.excessInputTokens)} token`);
  if (report.cost.counterfactualExcessInputCost !== null) {
    console.log(`若每次都保持在阈值内，超阈值输入回放成本下限约 ${money(report.cost.counterfactualExcessInputCost, report.cost.currency)}（反事实估算，不等于实际可省金额）`);
  }
  console.log('');
  console.log('逐回合:');
  console.log('  回合  调用      估算费用     首次输入     末次输入       峰值');
  for (const turn of report.turns) {
    console.log(`  ${String(turn.index).padStart(4)} ${String(turn.calls).padStart(5)} ${money(turn.cost, report.cost.currency).padStart(12)} ${formatNumber(turn.firstInput).padStart(12)} ${formatNumber(turn.lastInput).padStart(12)} ${formatNumber(turn.peakInput).padStart(10)}`);
  }
  console.log('');
  console.log('工具调用:');
  for (const item of report.tools.ranking.slice(0, 10)) {
    console.log(`  ${String(item.count).padStart(4)}x  输出 ${formatNumber(item.chars).padStart(8)}  单次最大 ${formatNumber(item.maxChars).padStart(8)}  ${item.name}`);
  }
  if (report.tools.largestOutputGroups.length) {
    console.log('');
    console.log('最大输出组:');
    for (const item of report.tools.largestOutputGroups) {
      console.log(`  ${String(item.count).padStart(4)}x  ${formatNumber(item.outputChars).padStart(8)}  ${item.name}`);
    }
  }
  console.log('');
  console.log(`图片输入: ${report.content.inputImages} 张 / ${formatNumber(report.content.inputImageChars)} 字符`);
  console.log(`重复工具调用: ${report.tools.duplicateCalls} 次`);
  console.log('');
  console.log('结论:');
  for (const finding of report.findings) console.log(`  [${finding.severity.toUpperCase()}] ${finding.message}`);
  console.log('');
  console.log('优化建议:');
  for (const recommendation of report.recommendations) console.log(`  - ${recommendation}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }
  try {
    const file = resolveSessionFile(options.target);
    const report = await analyze(file, options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

await main();
