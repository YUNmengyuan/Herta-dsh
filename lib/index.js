/**
 * dsh-herta 的 host（Node）半侧。
 *
 * 这个包同时出现在两个平面上，**它们是不同的东西，必须各司其职**：
 *
 *   · profile bundle 行（宿主面，`plane` 未设）
 *       —— 只负责让 client 半侧进入浏览器启动图，界面才存在。
 *          `@deepseek-ai/dsh-client-modules` 只扫 `loader.entries()`，
 *          而 preset 子树刻意不在这次遍历里，所以界面**必须**靠这一行。
 *       —— 如果在这里注册工具，会泄漏给**所有**会话（包括 standard）。
 *
 *   · preset 行（agent 面，`plane: preset`）
 *       —— 为「黑塔」这个 preset 的会话挂上她的记忆货架段与记忆工具。
 *          注册进的是 preset 的作用域层，只对该 preset 的 agent 可见。
 *
 * 两个实例的 `apply` 都会跑（ESM 缓存让模块只求值一次，但 fiber 是两个），
 * 所以**模块级可变状态必须与平面无关或按 key 索引** —— 下面的缓存按 cwd 索引。
 */
import { readNarrativeSync } from "./narrative.js";
import { HERTA_TOOLS } from "./tools.js";
import { hertaDreamTool } from "./dream.js";
import { registerVoiceRoute, hertaSpeakTool } from "./voice.js";
import { registerDirRoute } from "./static-route.js";
import { HERTA_UI_DIR, HERTA_UI_ROUTE } from "./herta-ui-route.js";

/** Cordis 插件名，与 cordis.patch.yml / preset 里的 loader 条目 id 一致。 */
export const name = "herta";

/** 注册 prompt 段与工具需要的两个服务。 */
export const inject = ["tools", "systemPrompt"];

/**
 * prompt 段的 `text` 必须是**同步**的（DSH 没有异步 prompt provider），
 * 而读货架是 IO。所以这里做一层按 cwd 索引的小缓存：组装时同步查表，
 * 表过期才重新读盘。
 *
 * 键必须是 cwd 而不是模块级单值 —— preset 实例是常驻的，会服务多个会话。
 */
const CACHE_TTL_MS = 3_000;
const narrativeCache = new Map();

function narrativeFor(cwd) {
  const now = Date.now();
  const hit = narrativeCache.get(cwd);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit;

  let entry;
  try {
    const r = readNarrativeSync(cwd);
    entry = { at: now, text: r.text, tokens: r.tokens };
  } catch (error) {
    // 读盘失败不该让整次组装炸掉 —— 退化成本段为空并记下原因。
    entry = { at: now, text: "", tokens: 0, error: String(error?.message ?? error) };
  }
  narrativeCache.set(cwd, entry);
  return entry;
}

/**
 * @param ctx - 宿主 cordis 上下文。
 * @param config - loader 行配置；`plane: 'preset'` 标记 agent 面那一行。
 */
export function apply(ctx, config) {
  const plane = config?.plane ?? "host";
  // 挂载日志保留是有意的：DSH 的插件挂载失败往往是静默的，
  // 而「这个包到底有没有被挂上、挂在哪个平面」是排查一切问题的第一问。
  console.log(`[dsh-herta] host 半侧已挂载（plane=${plane}）`);

  // 宿主面这一行只做**进程级**的两件事：
  //   1. 让 client 半侧进启动图（由包里的 dsh.client 声明自动完成，不需要代码）
  //   2. 把 80 条语音资产的静态路由挂上（C 层，静态资源挂一次就够）
  // 不在这里注册任何模型可见的东西 —— 那会泄漏给所有会话。
  if (plane !== "preset") {
    // 用 `ctx.inject` 而不是直接 `ctx.get('webServer')`：宿主行的挂载早于
    // webserver 行就绪，直接 get 会拿到 undefined（实测就是这样，日志会打
    // 「没有 webServer」）。`inject` 会等服务出现再回调，且在没有 web 的
    // 组合（无头/SDK）里只是永远不触发，不会把插件卡成 PENDING。
    ctx.inject(["webServer"], (scoped) => {
      scoped.effect(() => registerVoiceRoute(scoped) ?? (() => {}), "dsh-herta: voice route");
      // 「Herta 整机」页面（甲方案）：入口 html 不缓存，改了刷新即可见。
      scoped.effect(
        () =>
          registerDirRoute(scoped, {
            prefix: HERTA_UI_ROUTE,
            dir: HERTA_UI_DIR,
            noCache: true,
          }) ?? (() => {}),
        "dsh-herta: herta-ui route",
      );
      console.log(`[dsh-herta] 整机页面已挂：${HERTA_UI_ROUTE}`);
    });
    return;
  }

  // ── 她的记忆货架段 ──────────────────────────────────────────────────────
  // order 100：紧跟在人格前缀（0）之后、第一方工具引导（500+）之前 ——
  // 与她自己那套「自传 + 废案样本 + 环境」的顺序一致。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "herta:narrative",
        order: 100,
        text: (context) => {
          const cwd = context.agent?.session.header.cwd;
          if (cwd === undefined) return "";
          // 空段落会被 renderPrompt 丢掉，所以货架为空时天然不占位。
          return narrativeFor(cwd).text;
        },
      }),
    "dsh-herta: narrative section",
  );

  // ── 她的记忆 / 做梦 / 发声工具 ───────────────────────────────────────────
  for (const tool of [...HERTA_TOOLS, hertaDreamTool, hertaSpeakTool]) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-herta: tool ${tool.name}`);
  }

  // ── 叙述调度层（方案 B）────────────────────────────────────────────────
  // 让她的回复恢复原版的叙述行为：分拍、thought tag、自我收回、supervisor 复核。
  // 详见 `docs/叙述调度层设计.md`。
  //
  // **刻意用动态 import**：静态 import 的解析失败发生在模块求值阶段，会让
  // **整个插件挂载失败** —— 那会把记忆 / 语音 / 界面一起弄坏。包在 try 里，
  // 最坏情况只是叙述层缺席，其余照常（宿主插件的裸包名解析见 narrative-layer.js
  // 的模块注释：DSH 用 profile 根作基准，不是插件目录）。
  void import("./narrative-layer.js")
    .then((m) => m.installNarrativeLayer(ctx))
    .catch((error) => {
      const marks = (globalThis.__DSH_HERTA_HOST__ ??= {});
      marks.narrativeInstalled = false;
      marks.narrativeError = String(error?.message ?? error);
      console.log(`[dsh-herta] 叙述层未挂载：${marks.narrativeError}`);
    });
}
