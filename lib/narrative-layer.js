/**
 * 叙述调度层的运行时接线。
 *
 * ## 一、为什么先探测再使用（曾经的拦路问题）
 *
 * `supervisor-llm.js` 需要 `@deepseek-ai/dsh-llm` 的 `BlockAssembler` /
 * `createUserMessage`。而插件代码里的裸包名 `@deepseek-ai/*` 是怎么解析的，
 * 曾经是个真问题：
 *
 *   · lab profile 的 `node_modules` 里**没有** `@deepseek-ai` 目录
 *   · 从**插件所在目录**用 `createRequire` 解析 `dsh-llm` / `dsh-tools`
 *     → `MODULE_NOT_FOUND`
 *   · 但现存代码 import `@deepseek-ai/dsh-tools` 却工作正常
 *
 * 答案在 `@deepseek-ai/cordis-plugin-loader/lib/index.js:274`：
 *
 * ```js
 * if (this.ctx.loader.internal) return this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
 * ```
 *
 * 它拿的是 **Node 自己的 ESM loader**（`ModuleLoader.fromInternal()` →
 * `getOrInitializeCascadedLoader()`），解析基准是 **`ctx.baseUrl`（profile 根）**，
 * **不是插件目录**。实测以 profile 为基准时 `dsh-llm` 解析正常、两个导出都是 function。
 *
 * 即便如此，接入仍用**动态 import + try/catch**：静态 import 的解析失败发生在
 * 模块求值阶段，会连累**整个插件**挂载失败，把记忆 / 语音 / 界面一起弄坏。
 *
 * ## 二、复核的完整行为
 *
 * `agent/turn-stopping`（`dsh-agent-loop` emit，turn 关闭前被 await）里：
 *
 *   1. 从会话表面取出**她的候选回话**（`session-surface.js`）
 *   2. 从 turn 里取**路由**（`supervisor.resolveRoute`）
 *   3. 问一次模型判决（`supervisor-llm.callSupervisor`）
 *   4. 否决 → 检查配额 → 按阶段注入 rethink / respeak 提示（`agent.steer`）
 *
 * 三条安全底线（缺一条都会出真问题）：
 *   · **任何失败一律放行** —— 复核坏了不该让她说不出话
 *   · **配额到顶一律放行** —— `steer` 会让 turn 继续，持续否决她将永远说不完
 *   · **拿不到路由就跳过** —— 不猜模型（`GenerateOptions.provider/model` 必填）
 */

import { VetoBudget, buildVetoSteering, resolveRoute } from "./supervisor.js";
import { pickCandidate, pickRecent } from "./session-surface.js";

/** 一次探测的结果缓存。 */
let probeCache = null;

/**
 * 探测叙述层需要的依赖是否可用（结果缓存）。
 *
 * @returns {Promise<{ok: boolean, reason?: string, llm?: object}>} 探测结果。
 */
export async function probeNarrativeDeps() {
  if (probeCache !== null) return probeCache;
  try {
    const llm = await import("@deepseek-ai/dsh-llm");
    if (typeof llm.BlockAssembler !== "function") {
      probeCache = { ok: false, reason: "dsh-llm 没有导出 BlockAssembler" };
      return probeCache;
    }
    if (typeof llm.createUserMessage !== "function") {
      probeCache = { ok: false, reason: "dsh-llm 没有导出 createUserMessage" };
      return probeCache;
    }
    probeCache = { ok: true, llm };
  } catch (error) {
    probeCache = { ok: false, reason: String(error?.message ?? error) };
  }
  return probeCache;
}

/**
 * 复核一个 turn，必要时否决（注入提示让她重说）。
 *
 * **永不抛错**：任何一步出问题都记一条日志然后放行。
 *
 * @param {object} params
 * @param {object} params.ctx - 宿主 cordis 上下文（`ctx.llm` 才是 LLM 服务）。
 * @param {object} params.agent - turn-stopping 载荷里的 agent。
 * @param {number} params.turn - turn 号。
 * @param {AbortSignal} [params.signal] - turn 的取消信号。
 * @param {VetoBudget} params.budget - 否决配额。
 * @param {object} params.marks - 诊断标记对象。
 * @returns {Promise<boolean>} 是否否决（true = 已 steer，turn 会继续）。
 */
export async function reviewTurn({ ctx, agent, turn, signal, budget, marks }) {
  const session = agent?.session;
  if (session === null || session === undefined) return false;

  const eventAt = (seq) => session.eventAt(seq);
  const deriveMessage = (event) => session.deriveEventMessage(event);
  const nodes = session.surface?.nodes ?? [];

  const candidate = pickCandidate({ nodes, eventAt, deriveMessage });
  if (candidate === null) {
    marks.supervisorLast = { turn, skipped: "no-candidate" };
    return false;
  }

  const route = resolveRoute(agent);
  if (route === null) {
    marks.supervisorLast = { turn, skipped: "no-route" };
    return false;
  }

  if (budget.canVeto(turn) === false) {
    marks.supervisorLast = { turn, skipped: "budget-exhausted" };
    console.log(`[dsh-herta] supervisor: turn ${turn} 否决配额已用尽，放行`);
    return false;
  }

  const recent = pickRecent({
    nodes,
    eventAt,
    deriveMessage,
    beforeSeq: candidate.seq,
  });

  const { callSupervisor } = await import("./supervisor-llm.js");
  const decision = await callSupervisor({
    // **必须是 `ctx.llm`（cordis 服务），不是 `dsh-llm` 模块** ——
    // `stream()` 长在服务上，模块里没有它。传错的表现是复核永远静默跳过
    // （callSupervisor 会因为 `typeof llm.stream !== "function"` 直接返回 null）。
    ctx,
    route,
    candidate: candidate.text,
    recent,
    signal,
  });

  marks.supervisorLast = {
    turn,
    verdict: decision?.verdict ?? null,
    reason: decision?.reason ?? null,
    candidateChars: candidate.text.length,
  };

  if (decision === null || decision.verdict !== "veto") return false;

  // ── 否决：按阶段注入提示 ────────────────────────────────────────────────
  const stage = budget.record(turn);
  const steering = buildVetoSteering(decision.reason);
  // 第一次否决让她「先重新想」，第二次让她「照想清楚的说」——
  // 这正是上游两阶段（rethink → respeak）的顺序。合并注入会显得矛盾，
  // 所以按否决次数分阶段。
  const text = stage === 1 ? steering.rethink : steering.respeak;

  try {
    const { createUserMessage } = probeCache?.llm ?? {};
    if (typeof createUserMessage !== "function") {
      marks.supervisorLast.steerError = "createUserMessage 不可用";
      return false;
    }
    agent.steer(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-herta" },
      }),
    );
    marks.supervisorVetoes = (marks.supervisorVetoes ?? 0) + 1;
    marks.supervisorLast.stage = stage;
    console.log(`[dsh-herta] supervisor 否决 turn ${turn}（第 ${stage} 次）：${steering.selfCorrection}`);
    return true;
  } catch (error) {
    marks.supervisorLast.steerError = String(error?.message ?? error);
    console.log(`[dsh-herta] supervisor 注入失败（已放行）：${marks.supervisorLast.steerError}`);
    return false;
  }
}

/**
 * 把叙述层挂到宿主上，并通过 `globalThis` 暴露诊断信息。
 *
 * 与客户端那套 `globalThis.__DSH_HERTA__` 同一个理由：DSH 不把宿主 cordis
 * 上下文暴露出来，从外部看进去的唯一手段就是一个全局标记。
 *
 * @param {object} ctx - 宿主 cordis 上下文。
 * @returns {Promise<object>} 诊断对象（同时挂在 `globalThis.__DSH_HERTA_HOST__`）。
 */
export async function installNarrativeLayer(ctx) {
  const marks = (globalThis.__DSH_HERTA_HOST__ ??= {});
  marks.narrativeInstalled = true;
  marks.installedAt = new Date().toISOString();

  const probe = await probeNarrativeDeps();
  marks.depsOk = probe.ok;
  if (!probe.ok) {
    marks.depsReason = probe.reason;
    console.log(`[dsh-herta] 叙述层依赖不可用，已跳过：${probe.reason}`);
    return marks;
  }
  delete marks.depsReason;
  console.log("[dsh-herta] 叙述层依赖就绪（dsh-llm 可用）");

  const budget = new VetoBudget();
  marks.vetoBudgetPerTurn = budget.max;

  // ── 复核：turn 关闭前问一次 ──────────────────────────────────────────────
  let turnStoppingSeen = 0;
  ctx.effect(
    () =>
      ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
        turnStoppingSeen += 1;
        marks.turnStoppingSeen = turnStoppingSeen;
        marks.lastTurnStopping = { turn, hasAgent: agent !== undefined && agent !== null };
        try {
          // 用 await：钩子是 serial 模式，turn 会在边界提交前等它。
          await reviewTurn({ ctx, agent, turn, signal, budget, marks });
        } catch (error) {
          // 兜底：reviewTurn 内部已全程 try，这里再包一层是双保险 ——
          // 复核绝不能让她的 turn 崩掉。
          marks.supervisorError = String(error?.message ?? error);
          console.log(`[dsh-herta] supervisor 异常（已放行）：${marks.supervisorError}`);
        }
      }),
    "dsh-herta: 复核（supervisor）",
  );

  // ── 诊断：turn 出错时也取一次路由 ───────────────────────────────────────
  // 为什么盯 `agent/error`：lab 与无 Key 环境里 turn 会以失败告终，
  // **`turn-stopping` 根本不会触发**（实测：界面显示「1 轮 1 步」但钩子没到），
  // 所以拿不到任何「路由能不能读出来」的证据。而 `agent/error` 在这条路径上
  // **会**触发，正好用它证明 `resolveRoute` 到底能不能从真实会话里取到
  // provider/model（`supervisor.js` 的单测只用了假对象，证明不了真实形状）。
  let agentErrorSeen = 0;
  ctx.effect(
    () =>
      ctx.on("agent/error", ({ agent, turn, step, error }) => {
        agentErrorSeen += 1;
        marks.agentErrorSeen = agentErrorSeen;
        try {
          const route = resolveRoute(agent);
          marks.routeFromErrorPath = route;
          marks.routeReadOk = route !== null;
          console.log(
            `[dsh-herta] 路由可读性实测（agent/error 路径）: ${route === null ? "取不到" : JSON.stringify(route)}`,
          );
          if (route === null) {
            // 取不到就顺手记下形状，方便下一轮定位（不抛错）。
            const keys = (o) => (o === null || o === undefined ? null : Object.keys(o).slice(0, 40));
            marks.routeMissShape = {
              sessionKeys: keys(agent?.session),
              hasRequestContext: typeof agent?.session?.requestContext,
              hasRequestHeader: typeof agent?.session?.requestHeader,
              surfaceKeys: keys(agent?.session?.surface),
              error: String(error?.message ?? error).slice(0, 120),
            };
          }
        } catch (e) {
          marks.routeProbeError = String(e?.message ?? e);
        }
        if (marks.agentShape === undefined && agent !== undefined && agent !== null) {
          const keys = (o) => (o === null || o === undefined ? null : Object.keys(o).slice(0, 40));
          marks.agentShape = { agentKeys: keys(agent), sessionKeys: keys(agent.session) };
        }
      }),
    "dsh-herta: 路由可读性诊断",
  );

  // ── 分拍：工具结果之后记一笔（行为待接）──────────────────────────────────
  let toolPostSeen = 0;
  ctx.effect(
    () =>
      ctx.on("tools/post-execute", (exec) => {
        toolPostSeen += 1;
        marks.toolPostSeen = toolPostSeen;
        marks.lastToolName = exec?.name ?? exec?.call?.name ?? null;
      }),
    "dsh-herta: 分拍（beat）",
  );

  marks.subscribed = true;
  return marks;
}
