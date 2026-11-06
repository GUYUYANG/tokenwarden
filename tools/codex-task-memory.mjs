#!/usr/bin/env node
// Durable, task-aware context for Codex.
//
// The hook reads only structured rollout records. It stores a compact task ledger
// outside the transcript, then re-injects that ledger after context compaction.
// Raw prompts, reasoning, screenshots, and tool output are never copied wholesale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const DEFAULT_STATE_DIR = path.join(CODEX_HOME, 'tokenwarden', 'task-memory');
const MAX_CONTEXT_CHARS = positiveIntegerEnv(
  'TOKENWARDEN_TASK_MEMORY_MAX_CHARS',
  2_200,
  'TOKEN_GUARD_TASK_MEMORY_MAX_CHARS',
);
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_CATCH_UP_BYTES = 64 * 1024 * 1024;

const CORRECTION_RE = /(?:无关|没有关系|不是原因|不是这个|不是因为|已经排除|不是由|别再|不要再|我都测了|我测了|已经测过|已经试过|实际上|我确认|打开时是|根本没|你搞错|误判|unrelated|not the cause|ruled out|already tested|i tested|confirmed|misdiagnosed)/i;
const COMPLAINT_RE = /(?:还是一样|还是这样|仍(?:然)?(?:一样|这样|没|不)|依然|没解决|没有解决|没修好|没用|又(?:出现|错|坏)|为什么.*(?:笨|错|一样)|修复了.*(?:遍|次)|同样的问题|同一个问题|same (?:issue|problem|result)|still (?:broken|failing|fails|wrong|not working)|did(?:n't| not) work|not fixed|fixed .* times)/i;
const CONTINUATION_RE = /(?:继续|还是这个|如上|上述|这个问题|刚才|之前|按你说的|同样|同一个问题|这次|再改|改成|continue|same issue|as before|as above|try again|change it|fix it)/i;
const COMPLETION_RE = /(?:已经(?:好了|修好|修复|正常|成功|生效)|现在(?:正常|好了|可以了)|验收通过|测试通过|确认解决|verified|works now|fixed now|tests? pass|confirmed fixed)/i;
const STRONG_WORK_RE = /(?:修复|修改|实现|优化|改造|调试|排查|部署|安装|扩展|验收|报错|修好|改成|bug|fix|patch|feature|implement|refactor|debug|deploy|install|migrate|release)/i;
const WORK_RE = /(?:修复|修改|实现|优化|改造|调试|排查|测试|部署|安装|运行|扩展|项目|代码|脚本|文件|版本|功能|验收|报错|bug|fix|patch|feature|test|build|run|project|code|script|file|version|function|error)/i;
const SIMPLE_RE = /(?:帮我查|搜索一下|查一下|介绍一下|解释一下|解释|是什么|为什么|怎么理解|比较一下|对比|推荐|资料|有没有.*项目|告诉我|科普|look up|search|explain|what is|why is|compare|recommend|documentation|tell me)/i;
const HYPOTHESIS_RE = /(?:可能|通常|根因|原因是|应该是|大概率|怀疑|导致|问题在于|因为|如果.*(?:则|就)|likely|probably|root cause|caused by|because|suspect|hypothesis)/i;
const VERIFICATION_RE = /(?:\b(?:npm|pnpm|yarn|node|pytest|go test|cargo test|swift test|xcodebuild|playwright)\b|测试|构建|验证|复现|截图)/i;

function positiveIntegerEnv(name, fallback, legacyName = '') {
  const value = Number(process.env[name] ?? (legacyName ? process.env[legacyName] : undefined));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function enabled() {
  const value = process.env.TOKENWARDEN_TASK_MEMORY ?? process.env.TOKEN_GUARD_TASK_MEMORY;
  return value === undefined || !/^(0|false|off|no)$/i.test(value);
}

function nowIso() {
  return new Date().toISOString();
}

function safeSessionId(value) {
  const id = String(value || '').replace(/[^A-Za-z0-9._-]/g, '');
  return id || 'unknown-session';
}

function resolveStateDir(stateDir) {
  return path.resolve(stateDir
    || process.env.TOKENWARDEN_TASK_MEMORY_DIR
    || process.env.TOKEN_GUARD_TASK_MEMORY_DIR
    || DEFAULT_STATE_DIR);
}

function stateFile(sessionId, stateDir) {
  return path.join(resolveStateDir(stateDir), `${safeSessionId(sessionId)}.json`);
}

function ensureStateDir(stateDir) {
  fs.mkdirSync(resolveStateDir(stateDir), { recursive: true });
}

function readState(sessionId, stateDir) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(stateFile(sessionId, stateDir), 'utf8')), sessionId);
  } catch {
    return emptyState(sessionId);
  }
}

function writeState(state, stateDir) {
  ensureStateDir(stateDir);
  const target = stateFile(state.sessionId, stateDir);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  state.updatedAt = nowIso();
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, target);
}

function recordEvent(entry, stateDir) {
  try {
    const directory = resolveStateDir(stateDir);
    ensureStateDir(directory);
    fs.appendFileSync(path.join(directory, 'events.jsonl'), `${JSON.stringify({ at: nowIso(), ...entry })}\n`);
  } catch {}
}

function emptyState(sessionId) {
  return {
    version: 1,
    sessionId: safeSessionId(sessionId),
    taskKind: 'unknown',
    goal: '',
    cwd: '',
    transcriptPath: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cursor: { offset: 0 },
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
    lastInjectedHash: '',
    lastInjectedAt: '',
  };
}

function normalizeState(value, sessionId) {
  const base = emptyState(sessionId);
  return {
    ...base,
    ...value,
    sessionId: safeSessionId(value?.sessionId || sessionId),
    cursor: { ...base.cursor, ...(value?.cursor || {}) },
    loop: { ...base.loop, ...(value?.loop || {}) },
    userStatements: Array.isArray(value?.userStatements) ? value.userStatements : [],
    confirmedFacts: Array.isArray(value?.confirmedFacts) ? value.confirmedFacts : [],
    hypotheses: Array.isArray(value?.hypotheses) ? value.hypotheses : [],
    acceptance: Array.isArray(value?.acceptance) ? value.acceptance : [],
    files: Array.isArray(value?.files) ? value.files : [],
    evidence: Array.isArray(value?.evidence) ? value.evidence : [],
  };
}

function cleanText(value, limit = 400) {
  const text = String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function oneLine(value, limit = 240) {
  return cleanText(value, limit).replace(/\s+/g, ' ').trim();
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/(?:请|麻烦|这个|那个|一下|然后|现在|还是|已经|就是|真的|好像|为什么|可以|帮我|我们|你们|项目|问题)/g, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, '')
    .slice(0, 600);
}

function textTokens(value) {
  const normalized = normalizeForCompare(value);
  const tokens = new Set();
  for (const word of normalized.match(/[a-z][a-z0-9_-]{2,}/g) || []) tokens.add(word);
  const han = [...normalized].filter(ch => /\p{Script=Han}/u.test(ch)).join('');
  for (let index = 0; index < han.length - 1; index += 1) tokens.add(han.slice(index, index + 2));
  return tokens;
}

function similarity(left, right) {
  const a = textTokens(left);
  const b = textTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function sharedDistinctiveTokens(left, right) {
  const a = textTokens(left);
  const b = textTokens(right);
  const generic = new Set([
    '这个', '那个', '问题', '还是', '已经', '可以', '就是', '因为', '所以',
    '时候', '现在', '真的', '一个', '没有', '不是', '什么', '怎么', '如何',
  ]);
  return [...a].filter(token => b.has(token) && !generic.has(token));
}

function hasStrongTokenOverlap(left, right) {
  const a = textTokens(left);
  const b = textTokens(right);
  const shared = sharedDistinctiveTokens(left, right);
  const english = shared.filter(token => /^[a-z][a-z0-9_-]{2,}$/.test(token));
  const cjk = shared.filter(token => /^\p{Script=Han}{2}$/u.test(token));
  const smallSide = Math.min(a.size, b.size);
  return english.length > 0 || cjk.length >= 2 || (shared.length > 0 && smallSide > 0 && shared.length / smallSide >= 0.18);
}

function splitSentences(value) {
  return String(value || '')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map(item => oneLine(item, 320))
    .filter(item => item.length >= 6);
}

function stableId(prefix, value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function upsertUnique(list, item, key = 'text', max = 12) {
  const normalized = normalizeForCompare(item[key]);
  const existing = list.find(entry => normalizeForCompare(entry[key]) === normalized);
  if (existing) {
    Object.assign(existing, item);
  } else {
    list.push(item);
  }
  if (list.length > max) list.splice(0, list.length - max);
}

function extractContentText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return cleanText(content, 4_000);
  if (!Array.isArray(content)) return '';
  return cleanText(content
    .filter(block => block && typeof block === 'object')
    .filter(block => ['input_text', 'output_text', 'text'].includes(block.type))
    .map(block => block.text || '')
    .join('\n'), 4_000);
}

function isIgnorableUserText(text) {
  return /^(?:# AGENTS\.md instructions|<environment_context>|<skills_instructions>)/.test(text)
    || /<collaboration_mode>|Codex Cost Meter requires one billing snapshot/.test(text);
}

function classifyTask(currentKind, text) {
  const strongWork = STRONG_WORK_RE.test(text);
  const work = strongWork || WORK_RE.test(text);
  const simple = SIMPLE_RE.test(text);
  if (simple && !strongWork) {
    if (currentKind === 'unknown') return 'query';
    return currentKind;
  }
  if (work) return 'work';
  return currentKind;
}

function ensureGoal(state, text) {
  if (!state.goal && text) state.goal = oneLine(text, 500);
}

function addUserFact(state, text, reason) {
  const value = oneLine(text, 320);
  if (!value) return;
  upsertUnique(state.confirmedFacts, {
    id: stableId('fact', value),
    text: value,
    reason,
    source: 'user',
    at: nowIso(),
  }, 'text', 8);
}

function markMatchingHypothesesRejected(state, correction) {
  const ranked = state.hypotheses
    .filter(item => item.status !== 'rejected')
    .map(item => ({
      item,
      score: similarity(item.text, correction),
      shared: sharedDistinctiveTokens(item.text, correction),
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best && (best.score >= 0.16 || hasStrongTokenOverlap(best.item.text, correction))) {
    best.item.status = 'rejected';
    best.item.evidence = oneLine(correction, 320);
    best.item.rejectedAt = nowIso();
  }
}

function addRejectedHypothesis(state, correction) {
  const value = oneLine(correction, 320);
  if (!value) return;
  upsertUnique(state.hypotheses, {
    id: stableId('rejected', value),
    text: value,
    status: 'rejected',
    evidence: value,
    source: 'user',
    at: nowIso(),
    rejectedAt: nowIso(),
  }, 'text', 10);
}

function upsertAcceptance(state, text, status = 'reported-failing', origin = 'user') {
  const value = oneLine(text, 280);
  if (!value) return;
  upsertUnique(state.acceptance, {
    id: stableId('acceptance', value),
    text: value,
    status,
    source: 'user',
    origin,
    at: nowIso(),
  }, 'text', 8);
}

function markMatchingAcceptance(state, confirmation) {
  const ranked = state.acceptance
    .filter(item => item.status !== 'user-confirmed')
    .map(item => ({ item, score: similarity(item.text, confirmation) }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0] && ranked[0].score >= 0.12) {
    ranked[0].item.status = 'user-confirmed';
    ranked[0].item.evidence = oneLine(confirmation, 280);
    ranked[0].item.confirmedAt = nowIso();
    state.loop = { count: 0, signature: '', updatedAt: nowIso() };
  }
}

function conclusionWasRejected(state, conclusion) {
  if (/(?:不是.{0,12}(?:造成|导致|引起)|与.{0,12}无关|已经排除|不是原因)/i.test(conclusion)) return false;
  return state.hypotheses
    .filter(item => item.status === 'rejected')
    .some(item => {
      return similarity(item.text, conclusion) >= 0.16
        || hasStrongTokenOverlap(item.text, conclusion);
    });
}

function noteFailureLoop(state, complaint) {
  const value = oneLine(complaint, 320);
  state.loop.count = Number(state.loop.count || 0) + 1;
  state.loop.signature = value;
  state.loop.updatedAt = nowIso();
}

function processUserText(state, rawText, source = 'transcript') {
  const text = cleanText(rawText, 1_200);
  if (!text || isIgnorableUserText(text)) return false;
  const compact = oneLine(text, 500);
  const prior = state.userStatements.at(-1)?.text;
  if (prior && normalizeForCompare(prior) === normalizeForCompare(compact)) return false;

  ensureGoal(state, compact);
  state.taskKind = classifyTask(state.taskKind, compact);
  upsertUnique(state.userStatements, {
    id: stableId('user', compact),
    text: compact,
    source,
    at: nowIso(),
  }, 'text', 12);

  const correctiveSentences = splitSentences(text).filter(sentence => CORRECTION_RE.test(sentence));
  const complaintSentences = splitSentences(text).filter(sentence => COMPLAINT_RE.test(sentence));
  const confirmedSentences = splitSentences(text)
    .filter(sentence => CORRECTION_RE.test(sentence) || /(?:确认|已验证|实际上|确实|测过|试过)/i.test(sentence));
  const completionSentences = splitSentences(text).filter(sentence => COMPLETION_RE.test(sentence));
  const acceptanceStatements = splitSentences(text).filter(sentence => /(?:验收|期望|要求)/i.test(sentence));

  for (const sentence of confirmedSentences) addUserFact(state, sentence, 'user-statement');
  for (const sentence of acceptanceStatements) upsertAcceptance(state, sentence, 'stated', source);
  for (const sentence of correctiveSentences) {
    markMatchingHypothesesRejected(state, sentence);
    addRejectedHypothesis(state, sentence);
  }
  for (const sentence of completionSentences) markMatchingAcceptance(state, sentence);
  for (const sentence of complaintSentences) {
    upsertAcceptance(state, sentence, 'reported-failing', source);
  }
  if (complaintSentences.length) {
    if (state.latestAssistant) state.latestAssistantStatus = 'reported-failing';
    noteFailureLoop(state, complaintSentences.join(' '));
  }
  return true;
}

function processAssistantText(state, rawText) {
  const text = cleanText(rawText, 1_600);
  if (!text) return;
  state.latestAssistant = oneLine(text, 300);
  state.latestAssistantStatus = 'unverified';
  state.nextStep = '';
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (HYPOTHESIS_RE.test(sentence)) {
      upsertUnique(state.hypotheses, {
        id: stableId('hypothesis', sentence),
        text: oneLine(sentence, 260),
        status: 'candidate',
        source: 'assistant',
        at: nowIso(),
      }, 'text', 10);
    }
    if (/(?:下一步|接下来|需要先|应先|建议先)/i.test(sentence)) {
      state.nextStep = oneLine(sentence.replace(/^(?:下一步|接下来|需要先|应先|建议先)[：:\s]*/i, ''), 260);
    }
  }
}

function addFile(state, value) {
  let file = String(value || '').trim();
  if (!file) return;
  if (!path.isAbsolute(file) && state.cwd) file = path.resolve(state.cwd, file);
  const normalized = path.normalize(file);
  if (!normalized || normalized.length > 500) return;
  state.files = state.files.filter(item => item !== normalized);
  state.files.push(normalized);
  if (state.files.length > 10) state.files.splice(0, state.files.length - 10);
}

function processFunctionCall(state, payload) {
  if (payload?.type !== 'function_call') return;
  const name = String(payload.name || '');
  const args = String(payload.arguments || '');
  if (/apply_patch/i.test(name)) {
    for (const match of args.matchAll(/\*\*\* (?:Update|Add|Delete|Move) File:\s*([^\n]+)/g)) {
      addFile(state, match[1]);
    }
  }
  if (name === 'exec_command' || name === 'write_stdin') {
    let parsed = {};
    try {
      parsed = JSON.parse(args);
    } catch {}
    const command = String(parsed.cmd || '').split('\n')[0];
    if (command && VERIFICATION_RE.test(command)) {
      upsertUnique(state.evidence, {
        id: stableId('command-started', command),
        text: `执行 ${oneLine(command, 180)}`,
        status: 'started',
        source: 'tool',
        at: nowIso(),
      }, 'text', 10);
    }
  }
}

function processCommandCompleted(state, item) {
  if (item?.type !== 'CommandExecution') return;
  const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
  if (!command || !VERIFICATION_RE.test(command)) return;
  const status = Number.isInteger(item.exit_code) ? `exit ${item.exit_code}` : String(item.status || 'completed');
  upsertUnique(state.evidence, {
    id: stableId('command', `${command}|${status}`),
    text: `${oneLine(command.split('\n')[0], 170)} → ${status}`,
    status: item.exit_code === 0 ? 'passed' : 'failed',
    source: 'runtime',
    at: new Date(item.completed_at_ms || Date.now()).toISOString(),
  }, 'text', 10);
}

function applyRecord(state, record) {
  if (!record || typeof record !== 'object') return;
  if (record.type === 'session_meta') {
    state.cwd = String(record.payload?.cwd || state.cwd || '');
    state.sessionId = safeSessionId(record.payload?.session_id || record.payload?.id || state.sessionId);
    return;
  }
  if (record.type === 'turn_context') {
    state.cwd = String(record.payload?.cwd || state.cwd || '');
    return;
  }
  if (record.type === 'compacted') {
    state.compactionCount += 1;
    return;
  }
  if (record.type === 'response_item') {
    const payload = record.payload || {};
    if (payload.type === 'message') {
      const text = extractContentText(payload);
      if (payload.role === 'user') processUserText(state, text);
      if (payload.role === 'assistant') processAssistantText(state, text);
    }
    if (payload.type === 'function_call') processFunctionCall(state, payload);
    return;
  }
  if (record.type === 'event_msg' && record.payload?.type === 'item_completed') {
    processCommandCompleted(state, record.payload.item);
  }
}

async function readNewRecords(file, startOffset = 0, maxBytes = MAX_READ_BYTES) {
  const stat = await fs.promises.stat(file);
  let offset = Number(startOffset) || 0;
  if (offset > stat.size) offset = 0;

  const handle = await fs.promises.open(file, 'r');
  const records = [];
  let pending = Buffer.alloc(0);
  let position = offset;
  let consumed = 0;
  const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : Infinity;
  try {
    while (position < stat.size && consumed < byteLimit) {
      const chunkSize = Math.min(128 * 1024, stat.size - position, byteLimit - consumed);
      if (chunkSize <= 0) break;
      const chunk = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline).toString('utf8').trim();
        const lineBytes = newline + 1;
        consumed += lineBytes;
        pending = pending.subarray(lineBytes);
        if (line) {
          try {
            records.push(JSON.parse(line));
          } catch {}
        }
        newline = pending.indexOf(0x0a);
      }
    }
  } finally {
    await handle.close();
  }
  return { records, nextOffset: offset + consumed, consumed };
}

export async function analyzeTranscript(state, transcriptPath, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return state;
  state.transcriptPath = path.resolve(transcriptPath);
  const byteBudget = options.full ? Infinity : Math.max(1, Number(options.maxBytes) || MAX_CATCH_UP_BYTES);
  let remaining = byteBudget;
  while (remaining > 0) {
    const startOffset = Number(state.cursor?.offset) || 0;
    const result = await readNewRecords(transcriptPath, startOffset, Math.min(MAX_READ_BYTES, remaining));
    for (const record of result.records) applyRecord(state, record);
    state.cursor = { offset: result.nextOffset };
    if (!result.consumed || result.nextOffset <= startOffset) break;
    remaining -= result.consumed;
  }
  return state;
}

function promptFromInput(input) {
  const candidate = input?.prompt ?? input?.user_prompt ?? input?.message ?? '';
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) {
    return candidate.map(item => item?.text || item?.content || '').join('\n');
  }
  return '';
}

function pendingAcceptance(state) {
  const active = state.acceptance
    .filter(item => item.status === 'stated' || item.status === 'reported-failing' || item.status === 'blocked' || item.status === 'implemented');
  const interactive = active.filter(item => item.origin === 'hook');
  return (interactive.length ? interactive : active).slice(-2);
}

function stateHash(state) {
  return JSON.stringify({
    taskKind: state.taskKind,
    goal: state.goal,
    confirmedFacts: state.confirmedFacts.map(item => item.text),
    rejected: state.hypotheses.filter(item => item.status === 'rejected').map(item => item.text),
    acceptance: pendingAcceptance(state).map(item => `${item.status}:${item.text}`),
    files: state.files,
    evidence: state.evidence.slice(-4).map(item => item.text),
    nextStep: state.nextStep,
    loop: state.loop,
  });
}

export function describeTaskState(state, maxChars = MAX_CONTEXT_CHARS) {
  const rejected = state.hypotheses.filter(item => item.status === 'rejected').slice(-4);
  const facts = state.confirmedFacts.slice(-4);
  const acceptance = pendingAcceptance(state);
  const evidence = state.evidence.slice(-4);
  const files = state.files.slice(-6);
  const lines = [
    'TokenWarden 任务记忆（独立于对话摘要；来源优先级：用户确认 > 实时观测 > 助手推断）',
    '不得覆盖用户确认事实：对话摘要或助手推断与其冲突时一律视为失效。',
    `任务类型：${state.taskKind || 'unknown'}`,
  ];
  if (state.goal) lines.push(`目标：${oneLine(state.goal, 280)}`);
  if (facts.length) {
    lines.push('用户确认事实：');
    for (const item of facts) lines.push(`- ${oneLine(item.text, 260)}`);
  }
  if (rejected.length) {
    lines.push('已否定假设（禁止再次作为当前原因，除非出现新的反证）：');
    for (const item of rejected) {
      const source = item.source === 'assistant' ? '助手旧推断' : '用户反证';
      lines.push(`- [${source}] ${oneLine(item.text, 260)}`);
    }
  }
  if (acceptance.length) {
    lines.push('未完成验收：');
    for (const item of acceptance) lines.push(`- [${item.status}] ${oneLine(item.text, 240)}`);
  }
  if (evidence.length) {
    lines.push('最近证据：');
    for (const item of evidence) lines.push(`- ${oneLine(item.text, 220)}`);
  }
  if (files.length) {
    lines.push('已涉及文件：');
    for (const item of files) lines.push(`- ${item}`);
  }
  if (state.latestAssistant && !conclusionWasRejected(state, state.latestAssistant)) {
    const qualifier = state.latestAssistantStatus === 'reported-failing'
      ? '已被用户随后否定，不得当作完成证据'
      : '只是推断，不得覆盖用户事实';
    lines.push(`最近助手结论（${qualifier}）：${oneLine(state.latestAssistant, 260)}`);
  }
  if (state.nextStep) lines.push(`下一步：${oneLine(state.nextStep, 240)}`);
  if (Number(state.loop.count) >= 2) {
    lines.push(`重复失败熔断：同一验收已连续失败 ${state.loop.count} 次。不得继续直接提交相似补丁；`);
    lines.push('必须先提出可证伪的新假设并采集新的运行证据。没有新证据时明确列为 blocked。');
  }
  lines.push('取证规则：只读取相关文件段和定向日志；完整历史只通过 search 命令按需检索，不重放整份会话。');
  if (state.transcriptPath) {
    lines.push(`证据入口：node "${path.resolve(fileURLToPath(import.meta.url))}" search --session ${state.sessionId} --query <关键词>`);
  }
  const output = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > maxChars) break;
    output.push(line);
    length += line.length + 1;
  }
  return output.join('\n');
}

function isMeaningful(state) {
  return Boolean(state.goal || state.confirmedFacts.length || state.acceptance.length || state.compactionCount);
}

function shouldInject(state, event, mode, input) {
  if (!isMeaningful(state)) return false;
  if (event === 'SessionStart') {
    return input?.source === 'compact' && state.taskKind !== 'query';
  }
  if (event !== 'UserPromptSubmit') return false;
  if (mode === 'command') return false;
  const prompt = oneLine(promptFromInput(input), 500);
  const correction = CORRECTION_RE.test(prompt) || COMPLAINT_RE.test(prompt);
  const continuation = CONTINUATION_RE.test(prompt);
  if (state.taskKind === 'query' && !correction && !continuation) return false;
  if (correction || continuation || Number(state.loop.count) >= 2) return true;
  if (!prompt) return false;
  if (SIMPLE_RE.test(prompt) && !STRONG_WORK_RE.test(prompt)) return false;
  const hash = stateHash(state);
  return hash !== state.lastInjectedHash;
}

export async function handleHook(input, options = {}) {
  const event = String(input?.hook_event_name || '');
  const sessionId = safeSessionId(input?.session_id || input?.thread_id || '');
  if (!sessionId || sessionId === 'unknown-session') return { output: null, state: null };
  const stateDir = resolveStateDir(options.stateDir);
  const state = options.state || readState(sessionId, stateDir);
  const transcriptPath = input?.transcript_path || state.transcriptPath;
  await analyzeTranscript(state, transcriptPath);

  if (event === 'UserPromptSubmit') {
    const prompt = promptFromInput(input);
    if (prompt) processUserText(state, prompt, 'hook');
  }

  writeState(state, stateDir);
  if (!shouldInject(state, event, input?.mode, input)) {
    return { output: null, state };
  }
  const additionalContext = describeTaskState(state, options.maxChars || MAX_CONTEXT_CHARS);
  state.lastInjectedHash = stateHash(state);
  state.lastInjectedAt = nowIso();
  writeState(state, stateDir);
  recordEvent({
    event: 'inject-task-memory',
    sessionId,
    hookEvent: event,
    source: event === 'SessionStart' ? input.source : '',
    taskKind: state.taskKind,
    compactionCount: state.compactionCount,
    loopCount: state.loop.count,
    chars: additionalContext.length,
  }, stateDir);
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: event === 'SessionStart' ? 'SessionStart' : 'UserPromptSubmit',
        additionalContext,
      },
    },
    state,
  };
}

function findTranscriptById(sessionId, root = path.join(CODEX_HOME, 'sessions')) {
  const wanted = safeSessionId(sessionId);
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.includes(wanted)) return full;
    }
  }
  return '';
}

function optionValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(String(args[index + 1]));
  }
  return values;
}

async function readStdinJson(timeoutMs = 1_000) {
  if (process.stdin.isTTY) return {};
  return new Promise(resolve => {
    let text = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function* readSearchRecords(file) {
  if (!file || !fs.existsSync(file)) return;
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === 'response_item' && record.payload?.type === 'message') {
        const role = record.payload.role;
        if (role === 'user' || role === 'assistant') {
          yield { role, text: extractContentText(record.payload), timestamp: record.timestamp };
        }
      }
    } catch {}
  }
}

function printHelp() {
  process.stdout.write([
    '用法:',
    '  codex-task-memory.mjs show --session <id> [--json]',
    '  codex-task-memory.mjs refresh --session <id> [--transcript <path>] [--json]',
    '  codex-task-memory.mjs search --session <id> --query <关键词> [--limit 5]',
    '  codex-task-memory.mjs annotate --session <id> [--fact 文本] [--reject 文本] [--acceptance 文本] [--next 文本]',
    '  codex-task-memory.mjs hook   # Hook 模式，从 stdin 读取 Codex JSON',
    '',
  ].join('\n'));
}

async function main() {
  if (!enabled()) return;
  const args = process.argv.slice(2);
  const command = args[0] || 'hook';
  if (command === 'help' || command === '--help') {
    printHelp();
    return;
  }
  if (command === 'hook') {
    const input = await readStdinJson();
    const result = await handleHook(input);
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
    return;
  }

  const sessionId = optionValue(args, '--session');
  if (!sessionId) throw new Error('缺少 --session');
  const state = readState(sessionId);
  if (command === 'show') {
    await analyzeTranscript(state, optionValue(args, '--transcript', state.transcriptPath), { full: true });
    writeState(state);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else process.stdout.write(`${describeTaskState(state, MAX_CONTEXT_CHARS)}\n`);
    return;
  }
  if (command === 'refresh') {
    const transcript = optionValue(args, '--transcript', state.transcriptPath || findTranscriptById(sessionId));
    await analyzeTranscript(state, transcript, { full: true });
    writeState(state);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else process.stdout.write(`${describeTaskState(state, MAX_CONTEXT_CHARS)}\n`);
    return;
  }
  if (command === 'search') {
    const transcript = optionValue(args, '--transcript', state.transcriptPath || findTranscriptById(sessionId));
    const query = optionValue(args, '--query');
    const limit = Math.max(1, Math.min(20, Number(optionValue(args, '--limit', '5')) || 5));
    if (!query || !transcript) throw new Error('search 需要 --query 和可解析的会话记录');
    const terms = [...textTokens(query)];
    const matches = [];
    for await (const item of readSearchRecords(transcript)) {
      const score = terms.reduce((sum, term) => sum + (item.text.includes(term) ? 1 : 0), 0);
      const minimum = terms.length === 1 ? 1 : 2;
      if (score >= minimum && score / terms.length >= 0.3) matches.push({ ...item, score });
    }
    matches.sort((a, b) => b.score - a.score);
    for (const item of matches.slice(0, limit)) {
      process.stdout.write(`[${item.role}] ${oneLine(item.text, 500)}\n`);
    }
    return;
  }
  if (command === 'annotate') {
    const transcript = optionValue(args, '--transcript', state.transcriptPath || findTranscriptById(sessionId));
    await analyzeTranscript(state, transcript, { full: true });
    for (const fact of optionValues(args, '--fact')) addUserFact(state, fact, 'manual');
    for (const rejected of optionValues(args, '--reject')) addRejectedHypothesis(state, rejected);
    for (const acceptance of optionValues(args, '--acceptance')) upsertAcceptance(state, acceptance, 'reported-failing', 'manual');
    const next = optionValue(args, '--next');
    if (next) state.nextStep = oneLine(next, 260);
    writeState(state);
    process.stdout.write(`${describeTaskState(state, MAX_CONTEXT_CHARS)}\n`);
    return;
  }
  throw new Error(`未知命令: ${command}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch(error => {
    recordEvent({ event: 'task-memory-error', error: String(error?.message || error) });
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
