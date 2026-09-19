/**
 * 叙述调度层的运行时接线与自检。
 *
 * ## 为什么先探测再使用
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
 * 真正答案是 `@deepseek-ai/cordis-plugin-loader`：
 *
 * ```js
 * // lib/index.js:274
 * if (this.ctx.loader.internal) return this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
 * ```
 *
 * 它拿的是 **Node 自己的 ESM loader**（`ModuleLoader.fromInternal()` →
 * `getOrInitializeCascadedLoader()`），而解析基准是 **`ctx.baseUrl`（profile 根）**，
 * **不是插件目录**。实测以 profile 为基准时：
 *
 * ```
 * @deepseek-ai/dsh-llm -> E:\DeepSeek H\...\dsh-llm\lib\index.js   ✅
 * BlockAssembler / createUserMessage 都是 function              ✅
 * ```
 *
 * ## 这里为什么用动态 import
 *
 * 静态 `import` 的解析失败会在**模块求值阶段**抛错，导致整个插件挂载失败
 * —— 那会把已经验证过的记忆 / 语音 / 界面功能一起弄坏。动态 import 包在
 * try 里，最坏情况只是叙述层不可用，其余一切照常。
 */

/** 一次探测的结果，供诊断与测试使用。 */
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
 * 把叙述层挂到宿主上，并**通过 `globalThis` 暴露诊断信息**。
 *
 * 与客户端那套 `globalThis.__DSH_HERTA__` 同一个理由：DSH 不把宿主 cordis
 * 上下文暴露出来，从外部（另一个进程 / 无头浏览器）看进去的唯一手段就是一个
 * 全局标记。宿主侧目前没有等价的标记，所以这里建一个。
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

  // 订阅 turn 边界与工具结果 —— 前者是 supervisor 复核的时机，
  // 后者是分拍的时机。两者都先只登记，真正的行为在后续轮次接入。
  let turnStoppingSeen = 0;
  let toolPostSeen = 0;

  ctx.effect(
    () =>
      ctx.on("agent/turn-stopping", ({ agent, turn }) => {
        turnStoppingSeen += 1;
        marks.turnStoppingSeen = turnStoppingSeen;
        marks.lastTurnStopping = { turn, hasAgent: agent !== undefined && agent !== null };
        // 复核需要 provider/model，而 `SessionHeader` 里**没有**它们
        // （实测只有 id/createdAt/cwd/parentSession/isSeeded/origin/
        //  delegationDepth/agentPreset）。所以第一次触发时把 agent 的实际形状
        // 记下来并**打进日志** —— 宿主进程的 globalThis 从外面读不到，
        // 日志是唯一可靠的出口。下一轮据此写 resolveRoute。
        if (marks.agentShape === undefined && agent !== undefined && agent !== null) {
          const keys = (obj) => (obj === null || obj === undefined ? null : Object.keys(obj).slice(0, 50));
          marks.agentShape = {
            agentKeys: keys(agent),
            sessionKeys: keys(agent.session),
            headerKeys: keys(agent.session?.header),
          };
          console.log(`[dsh-herta] agent 形状实测: ${JSON.stringify(marks.agentShape)}`);
        }
      }),
    "dsh-herta: narrative turn-stopping probe",
  );

  ctx.effect(
    () =>
      ctx.on("tools/post-execute", (exec) => {
        toolPostSeen += 1;
        marks.toolPostSeen = toolPostSeen;
        marks.lastToolName = exec?.name ?? exec?.call?.name ?? null;
      }),
    "dsh-herta: narrative beat probe",
  );

  marks.subscribed = true;
  return marks;
}
