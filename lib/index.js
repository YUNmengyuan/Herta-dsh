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
 *       —— 也是**设置命名空间**的载体：只有 profile 顶层那一条 `id: herta`
 *          能被 `configEditor` 看到，所以 Config 只能挂在这一行上。
 *
 *   · preset 行（agent 面，`plane: preset`）
 *       —— 为「黑塔」这个 preset 的会话挂上她的记忆货架段与记忆工具。
 *          注册进的是 preset 的作用域层，只对该 preset 的 agent 可见。
 *
 * 两个实例的 `apply` 都会跑（ESM 缓存让模块只求值一次，但 fiber 是两个），
 * 所以**模块级可变状态必须与平面无关或按 key 索引** —— 下面的缓存按 cwd 索引，
 * 设置写回则只在宿主面跑（preset 行的 config 里只有 `plane`，那份默认值
 * 若也去写回，会把整机所有偏好打成默认值）。
 */
import z from "@deepseek-ai/schemastery";
import { readNarrativeSync } from "./narrative.js";
import { HERTA_TOOLS } from "./tools.js";
import { hertaDreamTool } from "./dream.js";
import { registerVoiceRoute, hertaSpeakTool } from "./voice.js";
import { registerDirRoute } from "./static-route.js";
import { registerVoiceModelRoute } from "./voice-model-route.js";
import { HERTA_UI_DIR, HERTA_UI_ROUTE } from "./herta-ui-route.js";
import { DEFAULTS, FIELD_NAMES, FIELDS, sanitizeFollowedFields } from "./settings-schema.js";
import {
  markLegacyVoiceFileImported,
  readHeretaSeed,
  readLegacyVoiceValues,
  syncHertaSettings,
} from "./settings-sync.js";

/** Cordis 插件名，与 cordis.patch.yml / preset 里的 loader 条目 id 一致。 */
export const name = "herta";

/** 注册 prompt 段与工具需要的两个服务。 */
export const inject = ["tools", "systemPrompt"];

/**
 * 设置命名空间 = profile 条目 id。
 *
 * 必须是字面量：`@deepseek-ai/dsh-settings` 的 `describe()` 按
 * `entry.options.id` 建表，客户端 `ctx.configForms.get(id)` 也按同一个 id 取。
 * 两处写死同一个字符串是有意的 —— 它们跨进程，没有可共享的常量。
 */
export const HERTA_SETTINGS_NAMESPACE = "herta";

/**
 * Volatile 引用协议（`@deepseek-ai/cosmokit` 的 `Symbol.for("cosmokit.volatile.write")`）。
 *
 * 用 `Symbol.for` 而不是从 cosmokit 取：那个符号是**跨 ESM/CJS 副本**的约定，
 * 所以这里不需要多一条裸包名依赖。判断方式与 cosmokit 的 `isVolatile` 逐字一致。
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** 这个值是不是 schemastery 造出来的 volatile 引用。 */
function isVolatileRef(value) {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * 插件 Config —— 「黑塔·整机」全部设置的**唯一真相**。
 *
 * ## 为什么每个字段都必须 `.volatile()`
 *
 * `@deepseek-ai/dsh-settings` 的 `volatileForm()` 只把 volatile 字段投影进表单：
 * 没有 volatile 字段的条目 `describe()` 直接跳过，写侧也会抛
 * `Plugin entry "herta" has no volatile fields`。换来的好处是这些字段**改了就生效**：
 * loader 把新值提交进同一个引用（`_commitVolatile`），不重挂插件。
 *
 * ## 为什么 schema 是**生成**的、不是手写的
 *
 * 字段名、合法取值、默认值都住在 `settings-schema.js` 的 `FIELDS` 里 ——
 * 客户端也要用同一份（页面标签、枚举选项、默认值）。手写一遍 schema
 * 等于给「字段名 ↔ 取值域」造第二个真相来源，而两者漂移的症状是
 * 「设置页能选，写回整机时被她判为非法」——她那边判非法的代价是
 * **整份设置文件回落默认**，所以这条不能靠人记。
 *
 * 平铺字段名（而不是嵌套的 `backend.thinking`）是客户端 API 逼出来的：
 * `ConfigForm.set(field, value)` 只接受根级单字段。
 */
export const Config = z.object({
  ...Object.fromEntries(
    FIELD_NAMES.map((field) => {
      const spec = FIELDS[field];
      if (spec.kind === "boolean") return [field, z.boolean().default(spec.def).volatile()];
      if (spec.kind === "enum") return [field, z.union([...spec.values]).default(spec.def).volatile()];
      return [field, z.string().default(spec.def).volatile()];
    }),
  ),
  /**
   * 用户明确声明「这一项跟随整机」的字段名。
   *
   * ## 为什么必须有它
   *
   * 写回的不变量是「只写 `user` 层里有的字段」，而**种子**会把整机那边有值的
   * 字段补进 `user` 层（这样页面显示的是真值）。两者合起来就产生一个单向门：
   * 一旦某项被种过，用户就只能改它、不能退回「跟随她自己的文件」——
   * 清掉覆盖会被下一轮种子立刻重新接管，按钮看起来毫无作用。
   *
   * 所以「跟随」必须是一条**不回退的声明**，而不是「当场删掉那个键」。
   *
   * ## 为什么它自己也 volatile
   *
   * `@deepseek-ai/dsh-settings` 的 `write()` 会用 `isVolatilePath` 逐个校验
   * 待写字段的路径：**非 volatile 的字段根本写不进去**（抛
   * `Config field "x" is not volatile`）。也就是说「另开一个非 volatile 的
   * 记录位」在这套 API 下做不到，只能把它做成 volatile 字段。
   *
   * 代价是它会出现在命名空间的 schema 里（`volatileForm` 不过滤它）。
   * 无害：我们自带页面，页面只渲染 `FIELDS` 里的字段，它不占任何 UI。
   */
  followedFields: z.array(z.string()).default([]).volatile(),
});

/**
 * 从 Config 里读出一份**普通对象**的设置快照。
 *
 * Config 上的每个值都是 volatile 引用（`{get(), [write]()}`），必须 `.get()`；
 * 直接 JSON 序列化引用拿到的是 `{}`。preset 行那份 config 只有 `plane`，
 * 缺的字段在这里回落到 schema 默认 —— 反正只有宿主面才用它。
 *
 * @param {Record<string, unknown>} config - `apply` 拿到的已解析 Config。
 * @returns {Record<string, unknown>} 每个字段都有普通值的对象。
 */
export function settingsSnapshot(config) {
  const out = {};
  for (const field of FIELD_NAMES) {
    const value = config?.[field];
    out[field] = isVolatileRef(value) ? value.get() : value === undefined ? DEFAULTS[field] : value;
  }
  return out;
}

/**
 * 读出「用户声明跟随整机」的字段名单。
 *
 * 只做「拆 volatile 引用」这一件事，清洗在 `settings-schema.js` 的
 * `sanitizeFollowedFields`（纯函数、可单测）。
 *
 * @param {Record<string, unknown>} config - `apply` 拿到的已解析 Config。
 * @returns {Set<string>}
 */
export function followedFields(config) {
  const raw = config?.followedFields;
  return sanitizeFollowedFields(isVolatileRef(raw) ? raw.get() : raw);
}

/**
 * 挂「设置写回」。
 *
 * ## 谁说了算：只写**用户真的在 DSH 里覆盖过**的字段
 *
 * DSH 的 `describe()` 给每个条目三段值：`value`（生效值）、`base`（继承层）、
 * `user`（profile 补丁里的显式覆盖）。**`user` 里有没有这个键，才是
 * 「用户管过这个设置没有」的判据** —— 比较值不行，因为「显式设成默认值」
 * 与「从没设过」在值上一样、在意图上完全不同（这是 DSH 自己文档里的口径）。
 *
 * 所以：
 *   · **拥有的字段**（在 `user` 里）→ 写回整机，DSH 说了算；
 *   · **没拥有的字段** → 整机文件里**一个字节都不动**。
 *
 * 没有这条，第一次挂载就会拿 schema 默认值把她所有偏好抹平，
 * 而现象只是「设置被重置了」，没人能看出是谁干的。
 *
 * ## 种子：把没拥有的字段先搬进来
 *
 * 但「没拥有」的另一面是「页面上显示的是默认值，而她实际用的是别的东西」——
 * 她那份文件里现在是 `theme:light` / `deviceScene:true` / `interactionLanguage:zh`，
 * 都不是 schema 默认。所以每次同步前先把**没拥有、而她那边有值**的字段读进来
 * 写一次（`settings.update`）。写进去之后它们就归 DSH 管了，页面显示的也是真值。
 *
 * 收敛性：`update` 会让字段进 `user` 层，下一轮就不再是「没拥有」，
 * 所以至多两轮就稳定；`update` 自己也只在有东西要改时才落盘。
 *
 * ## 顺序
 *
 * 先等 `settings` 服务出现，用 `ctx.inject` 而不是写进 `inject` 数组：
 * 无头 / SDK 组合里没有这个服务，硬依赖会让整个插件永不挂载 ——
 * 记忆、语音、界面会跟着一起没。没有这个服务时也**不写回**：
 * 那种组合里根本没有 DSH 设置页，写回只会是单方面的默认值覆盖。
 *
 * @param {object} ctx - 宿主面 cordis 上下文。
 * @param {Record<string, unknown>} config - `apply` 拿到的 Config。
 * @param {Record<string, unknown>} legacyValues - 旧语音偏好文件里读到的值
 *   （`apply` 已经读过并把它改名了）。它是**我们上一版写的**，所以比整机文件权威。
 */
function installSettingsWriteBack(ctx, config, legacyValues) {
  /**
   * `settings` 服务，由下面的 inject 回调填上。
   *
   * 写成「先置空、后填」而不是把监听器整个塞进 inject 回调，是因为**监听器
   * 必须挂在 `apply` 自己的 ctx 上**（见下面 `ctx.on` 的注释）。
   */
  let settingsService = null;

  /** 描述符里 `user` 层的键 = 用户在 DSH 里显式覆盖过的字段。 */
  const ownedFields = () => {
    if (settingsService === null) return new Set();
    try {
      const rows = settingsService.describe();
      const row = Array.isArray(rows) ? rows.find((entry) => entry.ns === HERTA_SETTINGS_NAMESPACE) : undefined;
      const user = row?.user;
      return new Set(user !== null && typeof user === "object" ? Object.keys(user) : []);
    } catch (error) {
      // 描述失败时保守到底：当成「什么都没拥有」，于是这一轮不写任何东西。
      console.log(`[dsh-herta] 读设置描述失败：${error?.message ?? error}`);
      return new Set();
    }
  };

  /** 正在迁移时不再触发第二轮迁移（`update` 会引发一次配置重载）。 */
  let seeding = false;

  /** 没拥有的字段里，整机那边有值的那些，搬进来。 */
  const seedMissing = (owned, values) => {
    if (seeding || settingsService === null) return;
    // 被声明「跟随整机」的字段不进来 —— 那正是那条声明的意思。
    const followed = followedFields(config);
    let seed;
    try {
      // `legacyVoice: false` —— 旧文件在 `apply` 里已经被读走并改名了。
      seed = readHeretaSeed({ workspace: values.workspace, legacyVoice: false });
    } catch (error) {
      console.log(`[dsh-herta] 读整机设置失败：${error?.message ?? error}`);
      return;
    }
    // 旧语音文件的值最后合上：它记的是本插件自己的偏好，优先级高于整机那份。
    const sources = { ...seed.values, ...legacyValues };
    const patch = {};
    for (const [field, value] of Object.entries(sources)) {
      if (owned.has(field) || followed.has(field)) continue;
      patch[field] = value;
    }
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    seeding = true;
    console.log(`[dsh-herta] 从整机迁移设置：${fields.join(", ")}`);
    void settingsService
      .update(HERTA_SETTINGS_NAMESPACE, patch)
      .catch((error) => {
        console.log(`[dsh-herta] 设置迁移失败：${error?.message ?? error}`);
      })
      .finally(() => {
        seeding = false;
      });
  };

  /** 一轮同步：先补种子，再只把拥有的字段写回整机。 */
  const sync = (reason) => {
    if (settingsService === null) return;
    const values = settingsSnapshot(config);
    const owned = ownedFields();
    seedMissing(owned, values);
    let report;
    try {
      report = syncHertaSettings(values, { only: owned });
    } catch (error) {
      // 写盘出问题不该让设置页崩掉；下一次改动还会再试一遍。
      console.log(`[dsh-herta] 设置写回异常（${reason}）：${error?.message ?? error}`);
      return;
    }
    for (const step of [report.global, report.workspace]) {
      if (step !== null && step.ok === false) {
        console.log(`[dsh-herta] 设置写回失败（${reason}）：${step.path} — ${step.error}`);
      }
    }
  };

  // **必须挂在这里，不能挂进下面的 inject 回调里。**
  //
  // `ctx.inject(deps, cb)` 在 cordis 里就是 `this.plugin({ inject, apply: cb })`
  // （`cordis/lib/index.js:1600-1606`），而 `plugin()` 会 `new Fiber(...)`
  // —— 回调拿到的是**另一条 fiber**。而 `loader/volatile-update` 只发给该条目
  // `fiber.config` 对应的那一条（`cordis-plugin-loader/lib/index.js:417-420`：
  // `self[Context.filter] = (owner) => owner.fiber === fiber`）。
  // 挂在子上下文上，事件会**静默**收不到：配置改了、值也提交了，写回却一次都不跑。
  // （实测踩到过：设置页点一下，`cordis.patch.yml` 跟着变，整机的文件纹丝不动。）
  ctx.on("loader/volatile-update", () => sync("volatile-update"));

  ctx.inject(["settings"], (scoped) => {
    settingsService = scoped.settings;
    // 自带页面：不这么声明，将来某个客户端按 schema 自动生成页时会多出一页。
    // owner 显式传 `ctx.fiber` —— 同上，子上下文不是这条插件实例的 fiber。
    scoped.effect(
      () => scoped.settings.configure({ auto: false }, ctx.fiber),
      "dsh-herta: settings presentation",
    );
    // 挂载时也同步一次：覆盖「上一次运行留下的显式覆盖」与「整机那边刚改过」两种情形。
    sync("mount");
    console.log(`[dsh-herta] 设置写回已挂：命名空间 ${HERTA_SETTINGS_NAMESPACE}`);
  });
}

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

  // 宿主面这一行只做**进程级**的三件事：
  //   1. 让 client 半侧进启动图（由包里的 dsh.client 声明自动完成，不需要代码）
  //   2. 把 80 条语音资产的静态路由挂上（C 层，静态资源挂一次就够）
  //   3. 把设置写回挂上（设置命名空间就挂在 profile 的这一行上）
  // 不在这里注册任何模型可见的东西 —— 那会泄漏给所有会话。
  if (plane !== "preset") {
    // 旧语音偏好：**先读、再改名**。顺序反了就等于把要迁移的东西先搬走。
    // 它只该发生一次，所以放在这里而不是写回回调里（写回会跑很多次）。
    const legacyValues = readLegacyVoiceValues();
    const legacy = markLegacyVoiceFileImported();
    if (legacy.imported) console.log(`[dsh-herta] 旧语音偏好已迁移：${legacy.path} → ${legacy.nextPath}`);
    else if (legacy.error !== undefined) {
      console.log(`[dsh-herta] 旧语音偏好改不动（保持原样）：${legacy.error}`);
    }

    // 设置写回**不依赖 webServer**：无头组合里也应该把值同步出去。
    installSettingsWriteBack(ctx, config, legacyValues);

    // 用 `ctx.inject` 而不是直接 `ctx.get('webServer')`：宿主行的挂载早于
    // webserver 行就绪，直接 get 会拿到 undefined（实测就是这样，日志会打
    // 「没有 webServer」）。`inject` 会等服务出现再回调，且在没有 web 的
    // 组合（无头/SDK）里只是永远不触发，不会把插件卡成 PENDING。
    ctx.inject(["webServer"], (scoped) => {
      scoped.effect(() => registerVoiceRoute(scoped) ?? (() => {}), "dsh-herta: voice route");
      // 本地语音模型（离线 TTS）的下载端点：GET 状态 / POST 动作。
      // 固定参数（URL/体积/SHA-256）来自上游 Herta，见 tts-release.js。
      scoped.effect(
        () => registerVoiceModelRoute(scoped) ?? (() => {}),
        "dsh-herta: voice model route",
      );
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
