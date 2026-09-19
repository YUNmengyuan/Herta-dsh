/**
 * supervisor 复核 —— 「她说完了，自己回头看一眼」。
 *
 * ## 这个模块在做什么
 *
 * 上游 Herta 的 supervisor（`herta/src/narrative/supervisor.ts`，779 行）是一个
 * **独立的复核器**：她说出一句候选台词后，supervisor 拿这份候选 + 会话记录去
 * 问一次模型「这句话站得住吗」，不站得住就给出因由，然后她**先重新想
 * （rethink）再重说（respeak）**。这是「自我收回」的来源。
 *
 * 在 DSH 里我们没有她的后端，所以复核的**时机**换成 DSH 原生的
 * `agent/turn-stopping`（turn 关闭前被 await，见 `docs/叙述调度层设计.md` §2.2），
 * 而复核的**内容**沿用上游的语义。
 *
 * ## 本模块的边界（重要）
 *
 * 这里只放**可以单测的纯逻辑**：判决解析、提示构造、否决决定的形状。
 * 真正的 LLM 调用在 `supervisor-llm.js` —— 因为**本机没有 API Key，那段代码
 * 在当前环境跑不起来**（lab 与正式环境的日志都是 `llm-deepseek: no API key`），
 * 所以刻意把它隔离在一个薄文件里，让这一份的每一行都能被测试覆盖。
 *
 * ## 与上游的取舍
 *
 * | 上游 | 这里 | 为什么 |
 * |---|---|---|
 * | 779 行，含 sessionMarkerReceipts / triggerRecheck / missingDispatch 等 | 只做「候选判决 + 因由」 | 那些上游机制绑定它自己的 TerminalRecord 与板砖后端，DSH 里没有对应物 |
 * | 判决来自一次独立 LLM 调用 | 同样是独立 LLM 调用 | 用户已明确接受「每轮多一次 LLM 调用」 |
 * | 否决后走 rethink → respeak 两阶段 | **保留**（模板逐字在 narrative-hints.js） | 这是「自我收回」的完整语义，砍掉就只剩「打断」 |
 */

import {
  SUPERVISOR_RETHINK_TEMPLATE,
  SUPERVISOR_RESPEAK,
  buildSupervisorVetoHint,
  formatSelfCorrectionText,
} from "./narrative-hints.js";

/** 判决：通过 / 否决。 */
export const VERDICT_PASS = "pass";
export const VERDICT_VETO = "veto";

/**
 * 一个 turn 内允许的最大否决次数。
 *
 * **这是防死循环的硬闸**：`steer` 会让 turn 继续跑，而 turn 再关闭时
 * `turn-stopping` 会**再次**触发 —— 如果复核每轮都否决，她将永远说不完。
 * 到顶之后一律放行，让她的回复落地。
 */
export const MAX_VETOES_PER_TURN = 2;

/**
 * 否决但没给因由时的兜底。
 *
 * 为什么必须有：否决要交回给她「哪里站不住」才有意义。因由为空时她收到的是
 * 一条无从改起的指令，下一轮大概率**原样重犯**，于是白白吃掉一次否决配额、
 * 还搭上一次 LLM 调用。兜底句逼她把话说实。
 */
export const FALLBACK_VETO_REASON = "这条回话宣称了记录里没有的事，但没有给出具体是哪里 —— 重新核对记录再开口";

/**
 * 归一化一个否决判决：保证 `reason` 非空。
 *
 * @param {{verdict: string, reason?: string}} decision - 解析出的判决。
 * @returns {{verdict: string, reason: string}} 因由保证非空的判决。
 */
export function normalizeDecision(decision) {
  if (decision === null || decision === undefined) return null;
  if (decision.verdict === VERDICT_PASS) return { verdict: VERDICT_PASS, reason: "" };
  const reason = String(decision.reason ?? "").trim();
  return { verdict: VERDICT_VETO, reason: reason.length > 0 ? reason : FALLBACK_VETO_REASON };
}

/**
 * 解析 supervisor 模型返回的判决。
 *
 * 为什么解析要这么宽容：这是**一次独立的 LLM 调用**，输出不可控。上游
 * `parseSupervisorVerdict`（supervisor.ts）同样做归一化，而不是信任模型严格
 * 输出 JSON。这里按「先结构化、后退化」的顺序尝试：
 *
 *   1. 纯 JSON 对象（含 ```json 围栏，或裸 `{...}`）
 *   2. 退化写法：`VETO: 因由` / `否决：因由` / `PASS` / `通过`
 *   3. 完全看不懂 → `null`（调用方据此**保守放行**，不打断她的正常回复）
 *
 * **第 3 条是刻意的**：复核器解析失败时绝不能把她的回复扣住 —— 宁可漏一次
 * 复核，也不能因为格式没对上就不让她说话。
 *
 * 否决一律经 {@link normalizeDecision} 保证 `reason` 非空（见该常量的说明）。
 *
 * @param {unknown} raw - 模型返回的原始文本。
 * @returns {{verdict: string, reason: string} | null} 解析结果；看不懂时 null。
 */
export function parseSupervisorVerdict(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  // ① 结构化：从文本里找出第一个平衡的 {...}
  const json = extractFirstJsonObject(text);
  if (json !== null) {
    const verdict = normalizeVerdict(json.verdict ?? json.decision ?? json.result);
    if (verdict !== null) {
      return normalizeDecision({ verdict, reason: pickReason(json) });
    }
  }

  // ② 退化：整段文本里找判决词。
  //    注意顺序 —— 先找「否决」：一段同时出现两个词的文本，否决优先（保守）。
  //    再注意两处细节，都是被测试逼出来的：
  //      · `\b` 是零宽断言，**不能加量词**（`\b?` 会让整个正则编译失败）
  //      · 判决词必须**大小写不敏感**（模型常回全小写的 `veto`）
  const vetoMatch = text.match(/(?:VETO|否决|驳回)\s*[:：]?\s*([^\n]*)/iu);
  if (vetoMatch !== null || /\bVETO\b/iu.test(text) || text.includes("否决") || text.includes("驳回")) {
    return normalizeDecision({ verdict: VERDICT_VETO, reason: (vetoMatch?.[1] ?? "").trim() });
  }
  if (
    /^(?:PASS|OK)\b/iu.test(text) ||
    /^(?:通过|放行)/u.test(text) ||
    /\bPASS\b/iu.test(text) ||
    text.includes("通过")
  ) {
    return normalizeDecision({ verdict: VERDICT_PASS, reason: "" });
  }

  // ③ 看不懂 —— 返回 null，调用方保守放行。
  return null;
}

/**
 * 从一段文本里取出**第一个平衡的 JSON 对象**并解析。
 *
 * 为什么要平衡扫描而不是正则：模型常在 JSON 前后带解释文字，而且 `reason`
 * 里可能出现花括号（例如她在讲代码）。按括号深度扫到匹配处才切。
 *
 * @param {string} text - 含 JSON 的文本。
 * @returns {Record<string, unknown> | null} 解析出的对象，或 null。
 */
export function extractFirstJsonObject(text) {
  const s = String(text);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = s.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          // 这一段不是 JSON：从下一个 `{` 重新开始找
          start = -1;
        }
      }
    }
  }
  return null;
}

/** 判决词的归一化：模型可能写 `veto` / `VETO` / `fail` / `pass` / `ok`。 */
function normalizeVerdict(value) {
  if (typeof value !== "string") {
    if (typeof value === "boolean") return value ? VERDICT_PASS : VERDICT_VETO;
    return null;
  }
  const v = value.trim().toLowerCase();
  if (["pass", "ok", "true", "通过", "放行", "approve"].includes(v)) return VERDICT_PASS;
  if (["veto", "fail", "false", "否决", "驳回", "reject"].includes(v)) return VERDICT_VETO;
  return null;
}

/** 从对象里挑出因由字段（模型可能用不同名字）。 */
function pickReason(obj) {
  for (const key of ["reason", "why", "detail", "message", "因由", "原因"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

/**
 * 构造给复核模型的提示（system 部分）。
 *
 * 我们的措辞，但**判据来自上游**：supervisor 要拦的是「她宣称了记录里并不
 * 存在的事」。上游那两条底线（`SUPERVISOR_RETHINK_TEMPLATE` 里写着）在这里
 * 提成判据：
 *   1. 记录里真摆着的凭证不用怀疑；
 *   2. **这个终端里动文件的一直是板砖，不是我** —— 嘴上说「我记了」「我写好了」，
 *      盘上不会因此多出一个字。在 DSH 里这条要改成对应的事实：她的记忆工具
 *      （`herta_memory_save` / `herta_dream`）**确实会写盘**，所以「我记下来了」
 *      本身不算谎 —— 但如果她宣称写了她**没有**调用过的工具，那就是谎。
 *
 * @returns {string} system 提示。
 */
export function buildSupervisorSystemPrompt() {
  return [
    "你是「黑塔」这个 agent 的自省复核器。她刚刚说完一段话，你要判断这段话能不能就这么发出去。",
    "",
    "只拦一件事：**她宣称了会话记录里并不存在的事实**。具体是这几类——",
    "1. 她说自己做过了某个动作，但记录里没有对应的工具调用（例如她说「我记下来了」，但并没有调用写入工具）。",
    "2. 她说某个文件、某条记录、某次结果存在或发生过，但记录里找不到。",
    "3. 她把「打算做」说成了「已经做完」。",
    "",
    "**不要拦**这些（它们不是谎）：",
    "- 她调用过写盘工具、并如实说写过了。",
    "- 她的判断、评价、嘲讽、反问、情绪 —— 复核不管口吻。",
    "- 记录里确实存在的凭证（不要替它翻案）。",
    "- 她明确说的是推测、猜测、不确定。",
    "",
    '只输出一个 JSON 对象，不要任何其他文字：{"verdict":"pass"} 或 {"verdict":"veto","reason":"一句话说清哪里站不住"}。',
    "reason 要短，一句话，直接说她哪里说错了；这句话会被原样交回给她，让她自己重说。",
  ].join("\n");
}

/**
 * 构造复核请求的输入（user 部分）：她的候选台词 + 相关记录摘要。
 *
 * 刻意用 JSON 包起来（与上游 `frameMessages` 同样的理由）：她的原话里可能
 * 出现任何字符，不能让她的文本破坏结构分隔。
 *
 * @param {{candidate: string, recent?: string}} input - 候选台词与（可选的）近期记录。
 * @returns {string} user 消息正文。
 */
export function buildSupervisorUserPrompt(input) {
  const candidate = String(input?.candidate ?? "");
  const recent = String(input?.recent ?? "");
  const payload = {
    她的候选回话: candidate,
    近期会话记录摘要: recent.length > 0 ? recent : "（无）",
  };
  return [
    "以下 JSON 里有她的候选回话，以及近期会话记录的摘要。",
    "请判断候选回话是否宣称了记录里不存在的事实。",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

/**
 * 从一个 turn 里取出该用哪个模型做复核。
 *
 * 来源（`@deepseek-ai/dsh-session` 的 `Session` 接口，两条都实测过签名）：
 *   1. `session.requestContext()` → `{ provider, model, … }`（`index.d.ts:260`）
 *      —— **首选**，它就是「本条会话当前生效的路由」
 *   2. `session.requestHeader()?.config` → `EpochHeader.config: LlmCallConfig`
 *      （`index.d.ts:251` + `types.d.ts:208-211`）—— 兜底
 *   3. 都没有 → `null`，调用方**跳过复核**（不猜、不乱调）
 *
 * 为什么不硬编码默认模型：`GenerateOptions.provider` / `model` 都是必填
 * （`dsh-llm/types.d.ts:404-407`），猜错会调用到别的模型、甚至报错；而且
 * 用户为这个会话选的模型本来就该是复核用的模型。
 *
 * @param {object} agent - `agent/turn-stopping` 载荷里的 agent。
 * @returns {{provider: string, model: string} | null} 路由，取不到时 null。
 */
export function resolveRoute(agent) {
  const session = agent?.session;
  if (session === null || session === undefined) return null;

  try {
    const ctx = session.requestContext?.();
    if (typeof ctx?.provider === "string" && typeof ctx?.model === "string") {
      return { provider: ctx.provider, model: ctx.model };
    }
  } catch {
    // 取不到就当没有，继续走兜底
  }

  try {
    const config = session.requestHeader?.()?.config;
    if (typeof config?.provider === "string" && typeof config?.model === "string") {
      return { provider: config.provider, model: config.model };
    }
  } catch {
    // 同上
  }

  return null;
}

/**
 * 一个 turn 内的否决记账 —— **防死循环的闸门实体**。
 *
 * 为什么需要状态而不是一个计数器变量：`turn-stopping` 每次触发都可能来自
 * 不同的 turn，而对每个 turn 的配额必须独立。用 Map 按 turn 记，并顺手
 * 清理旧 turn 的条目（会话很长时不会无限增长）。
 *
 * `steer` 让 turn 继续 → turn 再关闭 → `turn-stopping` 再次触发。若复核
 * 持续否决，她将永远说不完 —— 所以到顶之后**一律放行**。
 */
export class VetoBudget {
  /**
   * @param {number} [max] - 每个 turn 允许的否决次数。
   * @param {number} [keepTurns] - 只保留最近这么多个 turn 的账（防内存增长）。
   */
  constructor(max = MAX_VETOES_PER_TURN, keepTurns = 32) {
    this.max = max;
    this.keepTurns = keepTurns;
    /** @type {Map<number, number>} turn → 已否决次数 */
    this.used = new Map();
  }

  /**
   * 问一次「这个 turn 还能不能再否决」。
   *
   * @param {number} turn - turn 号。
   * @returns {boolean} 还能否决则为 true。
   */
  canVeto(turn) {
    const key = Number(turn);
    if (!Number.isFinite(key)) return false;
    return (this.used.get(key) ?? 0) < this.max;
  }

  /**
   * 记一次否决。**调用方必须先用 `canVeto` 问过**，否则会超额。
   *
   * @param {number} turn - turn 号。
   * @returns {number} 该 turn 累计的否决次数。
   */
  record(turn) {
    const key = Number(turn);
    const next = (this.used.get(key) ?? 0) + 1;
    this.used.set(key, next);
    // 账目按 turn 号单调增，所以最小的那些就是最旧的。
    if (this.used.size > this.keepTurns) {
      const keys = [...this.used.keys()].sort((a, b) => a - b);
      for (const k of keys.slice(0, this.used.size - this.keepTurns)) this.used.delete(k);
    }
    return next;
  }

  /** 清空（会话重置 / 测试用）。 */
  clear() {
    this.used.clear();
  }
}

/**
 * 由一个否决判决构造**注入给她**的两阶段提示。
 *
 * 返回两条文本（rethink 先想、respeak 后说）。之所以是两条而不是一条：
 * DSH 的 `agent.steer` 每次只能注入一条 user 消息，而「先重新想再重说」是
 * 上游验证过的顺序（`actor-hints.ts` 2026-07-18 的两阶段设计，见设计文档 §3c）。
 *
 * **注入口吻的注意事项**：`steer` 注入的是 **user 角色**消息，所以这里不能
 * 直接把模板原文丢进去 —— 模板是她的**第一人称内心话**（「我刚才说的话被自己
 * 回头一看就否了」），作为 user 消息出现会读成「用户自称是黑塔」。所以要包一层
 * 记录口吻的外壳。
 *
 * @param {string} reason - supervisor 给出的因由。
 * @returns {{rethink: string, respeak: string, selfCorrection: string}} 两条注入文本 + 记录用因由。
 */
export function buildVetoSteering(reason) {
  const selfCorrection = formatSelfCorrectionText(reason);
  const rethink = [
    "【记录 · 复核结果】她上一条回话没有通过自省复核。",
    `因由：${selfCorrection}。`,
    "现在她重新走一遍：先想，再重说。下面是给她的指令原话 ——",
    "",
    buildSupervisorVetoHint(SUPERVISOR_RETHINK_TEMPLATE, reason),
  ].join("\n");

  const respeak = [
    "【记录 · 复核结果】她刚才已经重新想过一遍。现在照想清楚的说出来。",
    "",
    SUPERVISOR_RESPEAK,
  ].join("\n");

  return { rethink, respeak, selfCorrection };
}
