/**
 * 语音设置 —— 用户偏好（引擎、实时语音开关）与「宿主事实」的**纯逻辑**。
 *
 * ## 为什么单开一个共享模块、且**放在 src/host/ 而不是 src/shared/**
 *
 * 与 `mapping.js` 同理：这两个消费者都要它，而都不是 Node 专属或浏览器专属 ——
 *   · **宿主侧**（`src/host/voice-settings.js`）用命名空间与默认值注册 DSH 设置域
 *   · **客户端侧**（`src/client/index.tsx`）用同一份默认值与归一化读回状态，
 *     并把它拼成 iframe 要的 `RealtimeVoiceState`
 * 因为无 import、无 DOM、无 Node，所以既能在 Node 里直接单测
 * （`scripts/test-voice-settings.mjs`），也能被 esbuild 原样打进 client bundle。
 *
 * **位置是被构建布局逼出来的**：`scripts/build.mjs` 把 `src/host/*.js` **平铺**
 * 拷进 `lib/`（不建子目录、也不拷 `src/shared/`）。宿主模块若写
 * `../shared/x.js`，在源码里能解析、拷进 `lib/` 后就**断了** ——
 * 而 `lib/index.js` 是**静态** import `./voice-settings.js` 的，那条断链会让
 * **整个插件挂载失败**（记忆 / 语音 / 界面一起没，即交接 §5 坑 1）。
 * 本机实测确认过（`Cannot find module '<pkg>\\shared\\voice-settings.js'`）。
 * 放进 `src/host/` 后，`./voice-settings-shared.js` 在 `src/host/` 与 `lib/`
 * 两种布局下都成立；客户端侧由 esbuild 内联，构建脚本无需改动。
 *
 * ## 存哪（2026-09-25 因 0.1.7-rc.2 再次改定）
 *
 * 引擎选择**不再**走 DSH 设置域，改由本插件**自持**：
 * 宿主把偏好落在 `$DSH_HOME/dsh-herta-voice.json`，并用一条白名单端点
 * （`GET/PUT /herta-settings`）供浏览器侧读写 —— 见 `src/host/voice-settings.js`。
 *
 * 为什么不是设置域：v0.1 时 DSH 提供 `SettingsProvider.register(ns, schema)` +
 * 客户端 `settingsScope.bind({ namespace })`，第三方插件能把偏好存进 DSH 的
 * 用户设置文档。**0.1.7-rc.2 把这两个 API 一起移除了**（实测：宿主
 * `ctx.settings.register` 不存在，客户端 `settingsScope` 服务不存在），
 * 取而代之的是「插件自己的 Config schema + 表单镜像」，没有第三方命名空间入口。
 *
 * 原设计的两个目标仍然成立，只是换了实现：
 *   · 跨重启保留 → 落在 `$DSH_HOME` 下的 JSON
 *   · 宿主与客户端只有一个真相来源 → 客户端不再自持副本，读写都走那一条端点
 *
 * 代价（如实记下）：这份偏好**不出现在 DSH 的设置界面里**，只能在黑塔自己的
 * 设置面板里改；也没有设置域自带的跨端失效广播。若 DSH 将来重新开放第三方
 * 命名空间注册，应当迁回去。
 *
 * ## 只存用户偏好，不存宿主事实
 *
 * 命名空间里只有两个字段（引擎、实时语音开关）——**刚好是 bridge 真正持久化的两个**。
 * 上游的 `muted`/`volume` 走它自己的渲染层 store（`voice-prefs.js`），
 * 不经 bridge；把它们也塞进来只会制造第二个真相来源。
 *
 * 密钥也**不进**这里：明文密钥归 DSH credentials（`MIMO_API_KEY`），
 * 这个 section 是用户可编辑的普通 JSON。
 */

/** 引擎判别式的合法值 —— 与上游 `VoiceEngine` 逐字同步（三处字面量见交接 §2.1）。 */
export const VOICE_ENGINES = Object.freeze(["local", "minimax", "mimo"]);

/** 默认值（用户从未选过时的回退；与设置域 schema 的 `.default()` 必须一致）。 */
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  engine: "local",
  realtimeVoice: true,
});

/** 一个空的掩码 Key 状态（「未设置」）。形状照抄上游 `DeepSeekKeyStatus`。 */
export function emptyKeyStatus() {
  return { set: false, hint: null, encrypted: false };
}

/** 是不是合法引擎值。 */
export function isVoiceEngine(value) {
  return typeof value === "string" && VOICE_ENGINES.includes(value);
}

/**
 * 把任意来源（设置域 section、坏掉的文档、undefined）归一成合法设置。
 *
 * **防御性**：设置域已按 schema 校验过，但客户端在「命名空间未注册 / 连线未就绪」
 * 时拿到的是 `undefined`（见 `SettingsScopeSnapshot.status`），
 * 这里一律回退默认值，绝不让一次缺失把整块设置面板弄崩。
 *
 * @param {unknown} section - 设置域里的 section，可能 undefined / 形状不对。
 * @returns {{engine: string, realtimeVoice: boolean}}
 */
export function normalizeVoiceSettings(section) {
  const src = section !== null && typeof section === "object" ? section : {};
  return {
    engine: isVoiceEngine(src.engine) ? src.engine : DEFAULT_VOICE_SETTINGS.engine,
    realtimeVoice:
      typeof src.realtimeVoice === "boolean"
        ? src.realtimeVoice
        : DEFAULT_VOICE_SETTINGS.realtimeVoice,
  };
}

/**
 * 宿主事实 —— 三个引擎**现在都还不可用**时的如实取值。
 *
 * ⚠️ 这份常量是**保守的「未知即否」**，不是实测结论：
 *   · `bundle` / `runtime`：DSH 侧还没接离线引擎（第三步），
 *     没有 model root 解析器可用来探测。报 false = 不声称任何它证明不了的可用性。
 *   · `minimax`：MiniMax 那条路只在上游 Electron 应用里存在，DSH 侧没有密钥通道。
 *   · `mimo`：MiMo 合成器已写好（`src/host/mimo-tts.js`）但还没实例化（第四步），
 *     密钥在 `MIMO_API_KEY` 环境变量里；客户端读不到它，所以这里报未设置。
 *
 * **这修掉了上一版的假绿**：那时 `bundle: true` + `runtime: true` 是硬编码的，
 * 于是 `localCanSpeak` 恒为真，设置面板把离线引擎显示成「已就绪」——
 * 而 DSH 当时根本合成不出一个音。
 *
 * 第三步/第四步接线后，这些事实要有真正的**宿主 → 客户端**通道
 * （设置域只管用户偏好，不管运行时事实）。
 */
export const UNWIRED_HOST_FACTS = Object.freeze({
  bundle: false,
  runtime: false,
  failed: false,
  modelPhase: "absent",
  minimaxKey: Object.freeze(emptyKeyStatus()),
  minimaxPlanKey: Object.freeze(emptyKeyStatus()),
  minimaxVoice: Object.freeze({ phase: "absent" }),
  minimaxRefusal: null,
  mimoKey: Object.freeze(emptyKeyStatus()),
  mimoVoice: Object.freeze({ phase: "absent" }),
});

/**
 * 拼出 iframe 要的 `RealtimeVoiceState`（上游 `bridge-types.ts:147-168`）。
 *
 * 字段一个不少、一个不多 —— 上游的 `VoiceSettings` 直接读这些键，
 * 少一个就显示 undefined，多一个只会被忽略。
 *
 * @param {unknown} settings - 已归一或未归一皆可（内部会归一）。
 * @param {typeof UNWIRED_HOST_FACTS} [facts] - 宿主事实；默认「都还没接线」。
 * @returns {object} `RealtimeVoiceState`。
 */
export function buildRealtimeVoiceState(settings, facts = UNWIRED_HOST_FACTS) {
  const s = normalizeVoiceSettings(settings);
  const f = facts !== null && typeof facts === "object" ? facts : UNWIRED_HOST_FACTS;
  // 离线模型的四个字段可以**整体**覆盖：宿主 `/herta-voice-model` 会给真实进度。
  // 没给就退回旧的 `modelPhase` + 三个零 —— 进度显示不出来，但不会崩。
  const m = f.model !== null && typeof f.model === "object" ? f.model : {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const phase =
    typeof m.phase === "string"
      ? m.phase
      : typeof f.modelPhase === "string"
        ? f.modelPhase
        : "absent";
  return {
    enabled: s.realtimeVoice,
    bundle: f.bundle === true,
    runtime: f.runtime === true,
    failed: f.failed === true,
    model: {
      phase,
      receivedBytes: num(m.receivedBytes),
      totalBytes: num(m.totalBytes),
      unpackedBytes: num(m.unpackedBytes),
    },
    engine: s.engine,
    minimax: {
      key: f.minimaxKey ?? emptyKeyStatus(),
      planKey: f.minimaxPlanKey ?? emptyKeyStatus(),
      voice: f.minimaxVoice ?? { phase: "absent" },
      refusal: f.minimaxRefusal ?? null,
    },
    mimo: {
      key: f.mimoKey ?? emptyKeyStatus(),
      voice: f.mimoVoice ?? { phase: "absent" },
    },
  };
}
