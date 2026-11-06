/**
 * TokenWarden DSH adapter — 让每一笔账单都变小，不只大账单。
 *
 * 四件事，全部对每一次请求生效：
 *  1. 工具描述瘦身（schema diet）：36 个工具占 10.6k token，小会话里是 88% 的成本。
 *     把描述压到第一句，参数结构原样保留 —— 工具一个不少，只是不再读长篇散文。
 *  2. 历史思考块过滤：DSH 每步把历史 reasoning 原样回发，实测占请求 37%。
 *  3. 单轮金额上限：一轮超过 turnCapCny 就停这一轮（和点停止同一条路径）。
 *  4. 余额闸门：开轮前读真实余额，不够跑一轮就不开跑。
 *
 * 压缩阈值不在这里 —— 它属于 preset（compaction-basic 的 thresholdRatio），
 * 本插件只在上下文异常涨过 40 万时兜底压一刀。
 *
 * 为什么用 { global: true }：这些事件是作用域派发的，宿主普通监听器收不到，
 * 这是 v1.0 静默失效的原因。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'tokenwarden';
export const inject = [];

// ¥/token，用 ledger.json 全量校准（2767.7M input → ¥218.61 ⇒ 7.90e-8）。
// 这是刹车用的估算，不是账本；准确数字看 dsh-cost-meter。
const RATE_IN = 7.9e-8;
const RATE_OUT = 2e-6;

const DEFAULT_TURN_CAP_CNY = 1.5;
const DEFAULT_COMPACT_ABOVE = 200_000;
const BRAKE_COOLDOWN_MS = 600_000;
const COMPACT_COOLDOWN_MS = 600_000;
const BALANCE_TTL_MS = 120_000;
const EXPECT_FALLBACK_CNY = 0.6;

const logFile = path.join(os.homedir(), '.dsh', 'tokenwarden', 'events.jsonl');

function record(entry) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}

function usageCost(usage) {
  if (!usage) return 0;
  const input = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0);
  const output = (usage.outputTokens || 0) + (usage.reasoningTokens || 0);
  return input * RATE_IN + output * RATE_OUT;
}

/** 从 AccountDetails.balance 里取人民币总额，取不到返回 null（不拦）。 */
function balanceCny(balance) {
  if (!balance || balance.status !== 'ready') return null;
  const wallets = [...(balance.value || []), ...(balance.bonusWallets || [])];
  const cny = wallets.filter((w) => w && w.currency === 'CNY');
  if (cny.length === 0) return null;
  const total = cny.reduce((sum, w) => sum + Number(w.balance || 0), 0);
  return Number.isFinite(total) ? total : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 取第一句（或到句号/分号/换行为止），超长则硬截并加省略号。 */
function firstSentence(text, cap) {
  if (typeof text !== 'string' || text.length <= cap) return text;
  const window = text.slice(0, cap * 2);
  const m = window.match(/^[\s\S]*?[.。!！?？;；:：]\s/);
  const sentence = (m ? m[0] : window.slice(0, cap)).trim();
  return sentence.length <= cap ? sentence : `${text.slice(0, cap).trimEnd()}…`;
}

/**
 * 递归压缩 schema 里的所有 description 字段。
 * 只动说明文字：类型、枚举、required、名称、嵌套结构全部保留。
 */
function dietSchema(schema, descCap, paramCap) {
  let saved = 0;
  const walk = (node, cap, isRoot) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, cap, false);
      return node;
    }
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') {
        const trimmed = firstSentence(value, cap);
        saved += value.length - trimmed.length;
        out[key] = trimmed;
      } else if (value !== null && typeof value === 'object') {
        out[key] = walk(value, cap, false);
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  const parameters = walk(schema.parameters, paramCap, false);
  const description = typeof schema.description === 'string'
    ? firstSentence(schema.description, descCap)
    : schema.description;
  saved += (schema.description || '').length - (description || '').length;
  return { schema: { ...schema, description, parameters }, saved };
}

function lastPromptTokens(session) {
  try {
    const to = Number(session.seq);
    const from = Math.max(0, to - 3000);
    const events = session.snapshotEvents(from, to) || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === 'assistant/message' && e.data?.usage) {
        return (e.data.usage.inputTokens || 0) + (e.data.usage.cacheReadTokens || 0);
      }
    }
  } catch {}
  return null;
}

export function apply(ctx, config = {}) {
  const turnCap = Number(config.turnCapCny) || DEFAULT_TURN_CAP_CNY;
  const compactAbove = Number(config.compactAboveTokens) || DEFAULT_COMPACT_ABOVE;
  const stripReasoning = config.stripOldReasoning !== false;
  const stripUnder = Number(config.stripOnlyUnderMessages) || Number.MAX_SAFE_INTEGER;
  const dietTools = config.dietTools !== false;
  const dietDescCap = Number(config.dietDescriptionChars) || 240;
  const dietParamCap = Number(config.dietParameterChars) || 90;
  /** sessionId -> { turn, cost, steps, brakeAt, notifiedAt } */
  const turns = new Map();
  /** 过去若干轮的实付费用，用来估"跑一轮要多少钱"。 */
  const completedCosts = [];
  let balanceCache = { at: 0, value: null, error: null };

  record({ event: 'loaded', version: '0.1.0', turnCap, compactAbove, stripReasoning, dietTools });

  const agentOf = (sessionId) => ctx.get('agents')?.get?.(sessionId);

  const readBalance = async () => {
    const now = Date.now();
    if (now - balanceCache.at < BALANCE_TTL_MS) return balanceCache;
    const account = ctx.get('deepseekAccount');
    if (!account?.getBalance) {
      balanceCache = { at: now, value: null, error: 'no-service' };
      return balanceCache;
    }
    try {
      const balance = await account.getBalance({
        version: 'tokenwarden-dsh/0.1.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      balanceCache = { at: now, value: balanceCny(balance), error: balance ? null : 'signed-out' };
    } catch (e) {
      balanceCache = { at: now, value: null, error: String(e?.code || e?.message || e) };
    }
    record({ event: 'balance', value: balanceCache.value, error: balanceCache.error });
    return balanceCache;
  };

  /** 和点"停止"按钮走同一条路，让会话停下来；再写一条原因给界面。 */
  const brake = (sessionId, reason) => {
    const s = turns.get(sessionId);
    const now = Date.now();
    if (s) {
      if (now - (s.brakeAt || 0) < BRAKE_COOLDOWN_MS) return;
      s.brakeAt = now;
    }
    record({ event: 'brake', session: sessionId, reason, turn: s?.turn ?? null, cost: s?.cost ?? 0, steps: s?.steps ?? 0 });
    try {
      const controller = ctx.get('sessionController');
      if (controller?.cancel) controller.cancel({ sessionId });
      else agentOf(sessionId)?.cancel?.({ kind: 'user' }, { keepInbox: true });
    } catch (e) {
      record({ event: 'brake-failed', session: sessionId, error: String(e?.code || e?.message || e) });
    }
    try {
      ctx.emit('api-session/error', sessionId, reason);
    } catch {}
  };

  /** 开轮闸门：余额撑不住一轮就别开跑。 */
  const gate = async (sessionId) => {
    const { value: balance } = await readBalance();
    if (balance === null) return;
    const typical = median(completedCosts.slice(-20));
    const need = Math.max(0.5, (typical ?? EXPECT_FALLBACK_CNY) * 2);
    if (balance >= need) return;
    brake(
      sessionId,
      `余额只剩 ¥${balance.toFixed(2)}，不够跑这一轮（近期一轮约 ¥${need.toFixed(2)}）。充值后说"继续"即可。`,
    );
  };

  ctx.on(
    'session/event',
    (session, event) => {
      const sessionId = session?.id;
      if (!sessionId || !event) return;

      if (event.type === 'turn/start') {
        const turn = Number(event.data?.turn || 0);
        const prev = turns.get(sessionId);
        turns.set(sessionId, {
          turn,
          cost: 0,
          steps: 0,
          brakeAt: prev?.brakeAt || 0,
          compactAt: prev?.compactAt || 0,
        });
        gate(sessionId).catch(() => {});
        return;
      }

      const state = turns.get(sessionId);
      if (!state) return;

      if (event.type === 'step/start') {
        state.steps += 1;
        return;
      }

      if (event.type === 'assistant/message' && event.data?.usage) {
        state.cost += usageCost(event.data.usage);
        if (state.cost > turnCap) {
          brake(
            sessionId,
            `这一轮已经花到 ¥${state.cost.toFixed(2)}（共 ${state.steps} 步），超过单轮上限 ¥${turnCap.toFixed(2)}，先停下。要接着做就说"继续"。`,
          );
        }
        return;
      }

      if (event.type === 'turn/end') {
        const cost = Number(state.cost.toFixed(4));
        completedCosts.push(cost);
        if (completedCosts.length > 50) completedCosts.shift();
        record({ event: 'turn-end', session: sessionId, turn: state.turn, steps: state.steps, cost });
        maybeCompact(sessionId, session, state);
      }
    },
    { global: true },
  );

  /** 上下文超过 compactAbove 就压一刀；不依赖预设配置是否生效。 */
  function maybeCompact(sessionId, session, state) {
    const surface = lastPromptTokens(session);
    record({ event: 'surface', session: sessionId, surface });
    if (typeof surface !== 'number' || surface <= compactAbove) return;
    const now = Date.now();
    if (now - ((state && state.compactAt) || 0) < COMPACT_COOLDOWN_MS) return;
    if (state) state.compactAt = now;
    record({ event: 'auto-compact', session: sessionId, surface, threshold: compactAbove });
    const agent = agentOf(sessionId);
    const commands = ctx.get('commands');
    Promise.resolve()
      .then(() => commands?.execute?.(agent, '/compact', [], new AbortController().signal))
      .then((res) => record({ event: 'auto-compact', session: sessionId, ok: true, result: res?.kind }))
      .catch((e) => record({ event: 'auto-compact', session: sessionId, ok: false, error: String(e?.code || e?.message || e) }));
  }

  // 会话真正空闲时才压（此时 agent 不在 running，能进 maintenance）。这是唯一可靠的时机。
  ctx.on('api-session/status', (sessionId, running) => {
    if (running) return;
    const agent = agentOf(sessionId);
    if (!agent?.session) return;
    record({ event: 'idle', session: String(sessionId) });
    maybeCompact(String(sessionId), agent.session, turns.get(String(sessionId)));
  });

  // 预热余额，让开轮闸门在 turn/start 时是同步判断，而不是等一次网络。
  readBalance().catch(() => {});

  // —— 工具描述瘦身 ——
  // 36 个工具的 schema 占 10.6k token。上下文只有 12k 的小会话里，这就是 88% 的钱。
  // 这里把所有 description 压到第一句（参数的类型/枚举/必填/结构全部不动），
  // 工具一个不减 —— 能力不损失，只是不再每步读一遍长篇说明。
  // assembly 是可变对象且返回值权威，直接在原地改即可。
  if (dietTools) {
    let lastLogAt = 0;
    let lastSig = '';
    ctx.on(
      'system-prompt/assemble',
      (assembly, context, next) => {
        const pending = next();
        return Promise.resolve(pending).then((resolved) => {
          const target = resolved ?? assembly;
          const tools = target?.tools;
          if (!Array.isArray(tools) || tools.length === 0) return target;
          let saved = 0;
          const slim = [];
          for (const tool of tools) {
            try {
              const result = dietSchema(tool, dietDescCap, dietParamCap);
              saved += result.saved;
              slim.push(result.schema);
            } catch {
              slim.push(tool);
            }
          }
          if (saved <= 0) return target;
          target.tools = slim;
          const now = Date.now();
          const sig = `${tools.length}:${saved}`;
          if (sig !== lastSig || now - lastLogAt > 60_000) {
            lastSig = sig;
            lastLogAt = now;
            record({ event: 'diet', tools: tools.length, chars: saved, savedTokens: Math.round(saved / 3.2) });
          }
          return target;
        });
      },
      { global: true },
    );
  }

  // —— 旧思考块清理 ——
  // DSH 每步都把历史上所有 reasoning 块原样发回模型（Anthropic Messages 风格的
  // thinking 回放）。实测这些块占新增长文的一半以上，而它们对后续推理没有用处。
  // 请求对象是 deepFreeze 的，改不了，只能带着改好的 messages 重新分发一次；
  // 内层流在消费者的上下文里懒创建，这样外层的计费器不会把它当成第二次请求重复记账。
  if (stripReasoning) {
    ctx.on(
      'llm/stream',
      (options, next) => {
        if (options?.purpose !== undefined) return next();
        const messages = options?.messages;
        if (!Array.isArray(messages) || messages.length > stripUnder) return next();
        let removed = 0;
        let chars = 0;
        const rewritten = [];
        for (const m of messages) {
          if (m?.role !== 'assistant' || !Array.isArray(m.content)) { rewritten.push(m); continue; }
          const kept = m.content.filter((b) => b?.type !== 'reasoning');
          if (kept.length === m.content.length) { rewritten.push(m); continue; }
          for (const b of m.content) if (b?.type === 'reasoning') chars += (b.text || '').length;
          removed += m.content.length - kept.length;
          rewritten.push({ ...m, content: kept });
        }
        if (removed === 0) return next();
        const llm = ctx.get('llm');
        if (!llm?.stream) return next();
        const session = String(options.sessionId || '');
        record({ event: 'strip', session, msgs: messages.length, removed, chars, savedTokens: Math.round(chars / 3.2) });
        return (async function* stripRelay() {
          try {
            // 懒创建：在消费方（计费器）的上下文里再分发，避免重复记账。
            for await (const chunk of llm.stream({ ...options, messages: rewritten })) yield chunk;
          } catch (e) {
            record({ event: 'strip-failed', session, error: String(e?.code || e?.message || e) });
            throw e;
          }
        })();
      },
      { global: true },
    );
  }

  record({ event: 'hooks-registered' });
}
