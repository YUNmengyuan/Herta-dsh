/**
 * 「黑塔·整机」设置的**字段表** —— 纯数据 + 纯函数，无 IO、无 import。
 *
 * ## 这份文件解决的问题
 *
 * 整机的设置原本散在四处、各有各的存法（见 `_herta-settings-統合設計.md` 的现状表）： 
 *   · 全局偏好  `%APPDATA%\Herta\settings.json`
 *   · 工作区偏好 `<workspace>\.herta\settings.json`
 *   · 语音偏好   `$DSH_HOME\dsh-herta-voice.json`（本插件自持，与上面**重复**）
 * 现在统一成**一个真相来源**：`dsh-herta` 插件的 Config（profile 的 `cordis.patch.yml`
 * 里那条 `herta` 条目），由宿主侧按本文件的字段表**写回**整机自己读的那两份文件。
 *
 * 所以本文件是唯一一处「字段名 ↔ 整机文件里的键」的对应关系。加一个设置项
 * 只需要动这里 + `src/host/index.js` 的 Config + 客户端的一行描述。
 *
 * ## 为什么字段是**平铺**的，不是嵌套的
 *
 * DSH 客户端写设置的口子是 `ConfigForm.set(field, value)`，它只接受**根级单字段**
 * （`{op:'set', path:[field]}`，见 `@deepseek-ai/dsh-client-ui-settings` 的
 * `config-form-types.d.ts`）。嵌套对象要走 `mutate` 拼路径，页面上每个控件都得
 * 知道自己在树里的位置 —— 平铺让「一个控件 ↔ 一个字段名」永远成立。
 * 写回整机时再由 `globalFileEdits` / `workspaceFileEdits` 还原成它要的嵌套形状。
 *
 * ## 两个「absent 有语义」的字段，单独说
 *
 * 整机把两件事编码成「键不存在」，而不是某个具体值：
 *   · `locale` —— 缺失 = **跟随系统语言**（`app-global-settings.ts:251` 按 OS 解析）
 *   · `interactionLanguage` —— 缺失 = **follow**（跟随 UI 语言，`settings-ipc.ts:228`）
 * 所以这两个字段的默认值分别是 `""` 与 `"follow"`，写回时**删掉该键**而不是写空串。
 * 把它们写成 `zh` 会把「跟随系统」变成「钉死在中文」——那不是同一个语义。
 *
 * ## 不搬的东西（连同理由，免得下一个人重新论证一遍）
 *
 *   · `windowState` —— 整机自己按 750ms debounce 捕获窗口几何并在关闭时再写一次
 *     （`index.ts:216-236`、`:384-393`），没有任何设置行读写它。搬进来必然互相覆盖。
 *   · `minimaxVoice` —— 服务端签发的克隆记录，整机自己 save/stampUsed 维护
 *     （`session-service.ts:1186-1216`）。属机器状态，不是用户偏好。
 *   · `muted` / `volume` / `sidebar.collapsed` —— 渲染层的 localStorage，不经 bridge，
 *     DSH 侧没有通道能读到或写到它们。
 *   · 三个 API 密钥 —— 归 DSH credentials / 环境变量，明文不进设置表单。
 *   · 桌宠（`herta-autostart`）的落点/置顶/目标屏 —— 那是**另一个程序**（A大黑塔桌宠），
 *     不是「整机」；它的落点文件由 `Record-HertaPosition.ps1` 录制、由
 *     `Start-HertaPet.ps1` 顶部常量兜底。要搬得先改那个 PowerShell 脚本的契约，
 *     与本文件的「写回整机自己读的文件」不是一类事情，故本轮不做。
 *
 * ## 合法取值从哪来（不是猜的）
 *
 *   · 全局：`Herta-src/packages/gui/src/main/app-global-settings.ts:130-171` 逐字段手写校验
 *   · 工作区：`Herta-src/packages/gui/src/main/app-settings.ts:15-81` 的值表与判定函数
 *   · 默认值：整机的 IPC getter，见下面每个字段的注释
 *
 * 值得一提的坑：整机读全局文件时**任一字段非法就整份回落 `{}`**
 * （`app-global-settings.ts:173-175` 的 catch 与各处的 `return {}`）。也就是说
 * 我们往那份文件里写一个错值，代价不是「那一个设置没生效」，而是**她所有偏好
 * 一起回到默认**。所以写回前一律过 `isManagedValue`，宁可少写不可写错。
 */

/**
 * 字段表。`where` 说明这个字段写进哪份文件：
 *   · `global`    → `%APPDATA%\Herta\settings.json`
 *   · `workspace` → `<workspace>\.herta\settings.json`
 *   · `meta`      → 不写进整机的任何文件，只在本插件里用（工作区路径本身就是这种）
 *
 * `def` 必须与整机 IPC getter 的默认值逐字一致；不一致的后果是「DSH 里显示的值」
 * 与「她实际在用的值」不同，而那是这个功能最不该出的错。
 */
export const FIELDS = Object.freeze({
  /** UI 外壳语言。`""` = 跟随系统（整机把「缺失」编码成这个语义）。 */
  locale: Object.freeze({
    kind: "enum",
    values: Object.freeze(["", "zh", "en"]),
    def: "",
    where: "global",
    label: "界面语言",
  }),
  /** 她被提示的语言。与 `locale` 独立，任意组合都合法。`follow` = 跟随 UI 语言。 */
  interactionLanguage: Object.freeze({
    kind: "enum",
    values: Object.freeze(["follow", "zh", "en"]),
    def: "follow",
    where: "global",
    label: "对话语言",
  }),
  /** 外观。整机默认 `"system"`（`settings-ipc.ts:277`）。 */
  theme: Object.freeze({
    kind: "enum",
    values: Object.freeze(["system", "light", "dark"]),
    def: "system",
    where: "global",
    label: "主题",
  }),
  /** 点关闭是收进托盘还是退出。整机默认 `true`（`settings-ipc.ts:249`），live 生效。 */
  closeToTray: Object.freeze({ kind: "boolean", def: true, where: "global", label: "关闭时收进托盘" }),
  /** 自动检查更新。整机默认 `true`（`settings-ipc.ts:262`）；关掉不影响手动检查。 */
  autoUpdate: Object.freeze({ kind: "boolean", def: true, where: "global", label: "自动检查更新" }),
  /** 3D 设备卡。整机默认 `true`（`DEVICE_SCENE_DEFAULT`）。 */
  deviceScene: Object.freeze({ kind: "boolean", def: true, where: "global", label: "3D 设备卡" }),
  /**
   * 谁在说话。整机默认 `"local"`（`settings-ipc.ts:331-332`）。
   * 注意：非法值会被整机**静默折成 `local`** —— 它不是 `readGlobalSettings` 的
   * 校验字段，是 getter 自己 clamp 的。
   */
  voiceEngine: Object.freeze({
    kind: "enum",
    values: Object.freeze(["local", "minimax", "mimo"]),
    def: "local",
    where: "global",
    label: "语音引擎",
  }),
  /** 实时语音总开关。整机默认 `true`（`settings-ipc.ts:306`），live 生效。 */
  realtimeVoice: Object.freeze({ kind: "boolean", def: true, where: "global", label: "实时语音" }),

  /**
   * 要同步的**工作区**根目录。空 = 不碰任何工作区文件。
   *
   * 为什么必须有这个字段：DSH 的设置是**profile 级**的（一条 Config 管一个 profile），
   * 而整机的工作区偏好在**每个工作区各一份**文件里。两者不是一回事，
   * 所以由用户显式指定一个路径，而不是让插件去猜「当前工作区是哪个」——
   * 设置页是 root 作用域，拿不到会话，猜出来的东西没法解释也没法复现。
   */
  workspace: Object.freeze({ kind: "path", def: "", where: "meta", label: "同步到工作区" }),

  /** 「做梦」。整机默认 `true`（`settings-ipc.ts:126`）；重启后生效。 */
  dreamEnabled: Object.freeze({ kind: "boolean", def: true, where: "workspace", label: "做梦" }),
  /** 板砖的推理档位。整机默认 `"high"`（`settings-ipc.ts:143`）；重启后生效。 */
  backendThinking: Object.freeze({
    kind: "enum",
    values: Object.freeze(["low", "high", "max"]),
    def: "high",
    where: "workspace",
    label: "推理档位",
  }),
  /** 板砖的工具契约。整机默认 `"minimal"`（`settings-ipc.ts:148`，owner 2026-08-17 从 standard 翻过来）。 */
  backendContract: Object.freeze({
    kind: "enum",
    values: Object.freeze(["standard", "minimal"]),
    def: "minimal",
    where: "workspace",
    label: "工具契约",
  }),
  /** 黑塔本体的模型。整机默认 `"deepseek-v4-pro"`（`settings-ipc.ts:183`）；重启后生效。 */
  modelsActor: Object.freeze({
    kind: "enum",
    values: Object.freeze(["deepseek-v4-pro", "deepseek-flash"]),
    def: "deepseek-v4-pro",
    where: "workspace",
    label: "黑塔的模型",
  }),
  /** 板砖的模型。整机默认 `"deepseek-flash"`（`settings-ipc.ts:188`）；重启后生效。 */
  modelsBackend: Object.freeze({
    kind: "enum",
    values: Object.freeze(["deepseek-v4-pro", "deepseek-flash"]),
    def: "deepseek-flash",
    where: "workspace",
    label: "板砖的模型",
  }),
});

/** 全部字段名，声明顺序即页面顺序。 */
export const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

/** 只写进全局文件（`%APPDATA%\Herta\settings.json`）的字段。 */
export const GLOBAL_FIELD_NAMES = Object.freeze(FIELD_NAMES.filter((n) => FIELDS[n].where === "global"));

/** 只写进工作区文件（`<workspace>\.herta\settings.json`）的字段。 */
export const WORKSPACE_FIELD_NAMES = Object.freeze(
  FIELD_NAMES.filter((n) => FIELDS[n].where === "workspace"),
);

/**
 * 默认值表，可直接喂给 schemastery 的 `.default()`。
 *
 * 与整机默认值逐字一致的意义是：**用户从没在 DSH 里改过任何东西时，
 * 写回整机的结果与她自己的默认行为完全相同** —— 也就是说这个页面在
 * 「什么都不改」的情况下是零影响的。
 */
export const DEFAULTS = Object.freeze(
  Object.fromEntries(FIELD_NAMES.map((name) => [name, FIELDS[name].def])),
);

/** 是不是本插件管的字段名。 */
export function isFieldName(name) {
  return Object.prototype.hasOwnProperty.call(FIELDS, name);
}

/**
 * 一个值是不是该字段的合法取值。
 *
 * 布尔字段只认真正的 `boolean`（`"true"` 不算）—— 整机的校验也是这个口径，
 * 而它一旦判定非法就整份回落默认，所以这里不能宽容。
 *
 * @param {string} name - 字段名。
 * @param {unknown} value - 待判定的值。
 * @returns {boolean}
 */
export function isManagedValue(name, value) {
  const field = FIELDS[name];
  if (field === undefined) return false;
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "enum") return typeof value === "string" && field.values.includes(value);
  // path：只约束类型与长度。空串是合法值（= 不同步工作区），不是「未设置」。
  if (field.kind === "path") return typeof value === "string" && value.length <= 4096;
  return false;
}

/**
 * 把任意来源的对象归一成**完整**的设置值：非法或缺席一律回落默认。
 *
 * 永不抛错，也永不返回缺键的对象 —— 调用方（写回、桥接应答）不该再判 undefined。
 *
 * @param {unknown} raw - 来自 Config、旧文件或 HTTP body 的任意值。
 * @returns {Record<string, unknown>} 每个字段都有值的对象。
 */
export function normalizeSettings(raw) {
  const src = raw !== null && typeof raw === "object" ? raw : {};
  const out = {};
  for (const name of FIELD_NAMES) {
    out[name] = isManagedValue(name, src[name]) ? src[name] : FIELDS[name].def;
  }
  return out;
}

/**
 * 从整机的全局设置文件里读出**我们管的那些字段**（用于首次种子）。
 *
 * 只取「文件里真的写了、且值合法」的键；缺席的字段不入结果 —— 缺席意味着
 * 「跟随系统 / follow / 用她自己的默认」，那不是我们该固化下来的值。
 *
 * @param {unknown} raw - `%APPDATA%\Herta\settings.json` 的解析结果。
 * @returns {Record<string, unknown>} 可能只有部分字段。
 */
export function valuesFromGlobalFile(raw) {
  const src = raw !== null && typeof raw === "object" ? raw : {};
  const out = {};
  for (const name of GLOBAL_FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(src, name)) continue;
    if (isManagedValue(name, src[name])) out[name] = src[name];
  }
  return out;
}

/**
 * 旧模型名 → 现名。
 *
 * 整机自己在读侧就折（`app-settings.ts:53-66` 的 `LEGACY_MODEL_NAMES` +
 * `normalizeModelChoice`），所以她的老工作区文件里可能还留着旧名。
 * 这里跟着折一步，是为了让设置页显示**她实际在用的那个模型** ——
 * 不折的话，读到 `deepseek-v4-flash` 会当成非法值丢掉，页面显示默认的
 * `deepseek-v4-pro`，而她在用 flash。显示错值比不显示更糟。
 */
export const LEGACY_MODEL_ALIASES = Object.freeze({
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
});

/** 把模型字段的旧名折成现名；不是模型字段或不需要折就原样返回。 */
function foldLegacyModelField(name, value) {
  if (name !== "modelsActor" && name !== "modelsBackend") return value;
  return typeof value === "string" && LEGACY_MODEL_ALIASES[value] !== undefined
    ? LEGACY_MODEL_ALIASES[value]
    : value;
}

/**
 * 从整机的工作区设置文件里读出我们管的那些字段（用于首次种子）。
 *
 * 整机的这份文件**不校验叶子值**（`app-settings.ts:120-140` 只看顶层是不是对象），
 * 由消费方在用时守卫。所以我们在这里补上守卫：读到非法值就当没读到。
 *
 * @param {unknown} raw - `<workspace>\.herta\settings.json` 的解析结果。
 * @returns {Record<string, unknown>} 可能只有部分字段。
 */
export function valuesFromWorkspaceFile(raw) {
  const src = raw !== null && typeof raw === "object" ? raw : {};
  const out = {};
  const section = (key) => {
    const value = src[key];
    return value !== null && typeof value === "object" ? value : {};
  };
  const dream = section("dream");
  const backend = section("backend");
  const models = section("models");
  const take = (name, value) => {
    const folded = foldLegacyModelField(name, value);
    if (isManagedValue(name, folded)) out[name] = folded;
  };
  take("dreamEnabled", dream.enabled);
  take("backendThinking", backend.thinking);
  take("backendContract", backend.contract);
  take("modelsActor", models.actor);
  take("modelsBackend", models.backend);
  return out;
}

/**
 * 把 `only` 归一成「该不该写这个字段」的判定。
 *
 * `undefined` 表示「全都写」（种子阶段的整份写回）。给集合时只写集合内的字段 ——
 * 这是**只写用户真的在 DSH 里覆盖过的字段**那条不变量的实现：
 * 没被覆盖的字段在整机文件里原样不动，她在自己应用里改的东西不会被我们拿默认值盖掉。
 *
 * @param {Iterable<string> | undefined} only - 允许写的字段名。
 * @returns {(name: string) => boolean}
 */
function fieldFilter(only) {
  if (only === undefined) return () => true;
  const set = only instanceof Set ? only : new Set(only);
  return (name) => set.has(name);
}

/**
 * 全局文件的写回意图。
 *
 * 形状是 `{ set, remove }` 而不是一个普通对象，因为有两个键必须能表达
 * 「**删掉它**」：`locale`（= 跟随系统）与 `interactionLanguage`（= follow）。
 * 只用 `set` 就没法把「跟随系统」写回去 —— 那会让用户选不回去。
 *
 * 布尔与枚举字段一律落 `set`：这里的语义是**DSH 是唯一真相**，
 * 用户把它设成默认值就是「我要它默认」，而不是「别管它」。
 * （「别管它」的表达方式是清掉该字段的覆盖，见客户端页面的「跟随整机」。）
 *
 * @param {unknown} values - 已归一或未归一的设置值。
 * @param {Iterable<string>} [only] - 只写这些字段；省略 = 全写。
 * @returns {{set: Record<string, unknown>, remove: string[]}}
 */
export function globalFileEdits(values, only) {
  const v = normalizeSettings(values);
  const writable = fieldFilter(only);
  const set = {};
  const remove = [];
  // 这两个字段的「默认值」在整机那边就是「键不存在」。写空串会让
  // `readGlobalSettings` 判定非法 → **整份文件回落 {}**，等于清掉她所有偏好。
  if (writable("locale")) {
    if (v.locale === "") remove.push("locale");
    else set.locale = v.locale;
  }
  if (writable("interactionLanguage")) {
    if (v.interactionLanguage === "follow") remove.push("interactionLanguage");
    else set.interactionLanguage = v.interactionLanguage;
  }
  for (const field of ["theme", "closeToTray", "autoUpdate", "deviceScene", "voiceEngine", "realtimeVoice"]) {
    if (writable(field)) set[field] = v[field];
  }
  return { set, remove };
}

/**
 * 工作区文件的写回意图。没有 `remove`：整机这五个字段的默认值都是**具体值**
 * 而不是「缺席」，所以永远是可写回的。
 *
 * `workspace` 为空串时返回 `undefined` —— 调用方据此跳过整份文件，
 * 而不是去写 `./.herta/settings.json` 这种相对路径（那会写到 DSH 进程的 cwd 里，
 * 是最难排查的一类 bug）。
 *
 * @param {unknown} values - 已归一或未归一的设置值。
 * @param {Iterable<string>} [only] - 只写这些字段；省略 = 全写。
 * @returns {{set: Record<string, unknown>} | undefined}
 */
export function workspaceFileEdits(values, only) {
  const v = normalizeSettings(values);
  if (typeof v.workspace !== "string" || v.workspace.trim() === "") return undefined;
  const writable = fieldFilter(only);
  // 整机的这份文件是**分节**的：只写被允许的叶子，空节不落盘
  // （写一个空 `dream: {}` 会让她读到「有这一节但没值」，与不写不是一回事）。
  const dream = writable("dreamEnabled") ? { enabled: v.dreamEnabled } : undefined;
  const backend = {};
  if (writable("backendThinking")) backend.thinking = v.backendThinking;
  if (writable("backendContract")) backend.contract = v.backendContract;
  const models = {};
  if (writable("modelsActor")) models.actor = v.modelsActor;
  if (writable("modelsBackend")) models.backend = v.modelsBackend;

  const set = {};
  if (dream !== undefined) set.dream = dream;
  if (Object.keys(backend).length > 0) set.backend = backend;
  if (Object.keys(models).length > 0) set.models = models;
  return { set };
}

/**
 * 清洗「跟随整机」名单（Config 的 `followedFields`）。
 *
 * 只认字段表里真实存在的字段名 —— 这份名单由客户端写进来，而 profile 的补丁是
 * 用户可以手改的文件；一个拼错的字段名不该改变任何行为，也不该静默生效。
 *
 * @param {unknown} value - `followedFields` 的原始值（可能坏掉、可能不是数组）。
 * @returns {Set<string>}
 */
export function sanitizeFollowedFields(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((field) => typeof field === "string" && isFieldName(field)));
}

/**
 * 旧语音偏好文件的字段名映射。
 *
 * `$DSH_HOME/dsh-herta-voice.json` 存的是 `{engine, realtimeVoice}`（见
 * `voice-settings-shared.js` 的文件头），只有这两个键是我们管的，
 * 所以迁移时逐个映射，不做整体展平 —— 那个文件里将来多出别的键时不该污染设置。
 */
export const LEGACY_VOICE_FIELD_MAP = Object.freeze({
  engine: "voiceEngine",
  realtimeVoice: "realtimeVoice",
});

/**
 * 把旧的语音偏好文件内容映射成设置值。
 *
 * @param {unknown} raw - `dsh-herta-voice.json` 的解析结果。
 * @returns {Record<string, unknown>} 可能只有部分字段（也可能是空对象）。
 */
export function valuesFromLegacyVoiceFile(raw) {
  const src = raw !== null && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [from, to] of Object.entries(LEGACY_VOICE_FIELD_MAP)) {
    if (isManagedValue(to, src[from])) out[to] = src[from];
  }
  return out;
}
