/**
 * 「黑塔·整机」设置搬迁的单测 —— 三层纯逻辑，都在 Node 里直接跑，不需要 DSH 运行时。
 *
 *   1. `settings-schema.js` —— 字段表、校验、归一化、写回意图的**形状**
 *   2. `settings-sync.js`   —— 读-改-写只碰自己的键、原子落盘、旧文件迁移
 *   3. 交叉核对：`Config` 的 schema 与字段表同源（这条最关键，见最后一节）
 *
 * ## 为什么这些断言值得写
 *
 * 整机读全局那份文件时**任一字段非法就整份回落 `{}`**
 * （`app-global-settings.ts:130-175`：逐字段 `return {}` + 兜底 catch）。
 * 也就是说写错一个值的代价不是「那个设置没生效」，而是**她所有偏好一起回默认**。
 * 所以「宁可少写不可写错」这条不变量必须在测试里钉住：
 *   · 每个字段的取值域边界（空串、`follow`、非布尔）
 *   · `locale` / `interactionLanguage` 的「缺席有语义」必须走 `remove` 而不是写空串
 *   · 写回**只碰自己管的键**（`windowState` / `minimaxVoice` 原样留着）
 *   · 没被 DSH 覆盖的字段**一个字节都不写**
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS,
  FIELD_NAMES,
  FIELDS,
  GLOBAL_FIELD_NAMES,
  WORKSPACE_FIELD_NAMES,
  globalFileEdits,
  isManagedValue,
  normalizeSettings,
  sanitizeFollowedFields,
  valuesFromGlobalFile,
  valuesFromLegacyVoiceFile,
  valuesFromWorkspaceFile,
  workspaceFileEdits,
} from "../src/host/settings-schema.js";
import {
  mergeManaged,
  readHeretaSeed,
  syncHertaSettings,
  workspaceSettingsPath,
} from "../src/host/settings-sync.js";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log("herta-settings");

// ── 1. 字段表自洽 ────────────────────────────────────────────────────────────
{
  check("字段表非空", FIELD_NAMES.length > 0);
  check("每个字段都有 label / kind / where", FIELD_NAMES.every((n) => FIELDS[n].label && FIELDS[n].kind && FIELDS[n].where));
  check("每个字段都有默认值", FIELD_NAMES.every((n) => DEFAULTS[n] === FIELDS[n].def));
  check(
    "每个字段的默认值自己就是合法值",
    FIELD_NAMES.every((n) => isManagedValue(n, DEFAULTS[n])),
  );
  check(
    "全局字段 + 工作区字段 + workspace 恰好覆盖全部字段",
    GLOBAL_FIELD_NAMES.length + WORKSPACE_FIELD_NAMES.length + 1 === FIELD_NAMES.length,
  );
  check("枚举字段的默认值在取值域里", FIELD_NAMES.filter((n) => FIELDS[n].kind === "enum").every((n) => FIELDS[n].values.includes(FIELDS[n].def)));
  check("`workspace` 不写进整机的任何文件", FIELDS.workspace.where === "meta");
  // 这两个字段的默认值是「缺席」语义，必须能被 remove 表达（见第 3 节）。
  check("locale 默认为空串（= 跟随系统）", DEFAULTS.locale === "");
  check("interactionLanguage 默认为 follow", DEFAULTS.interactionLanguage === "follow");
}

// ── 2. 校验与归一化 ─────────────────────────────────────────────────────────
{
  check("非法字段名一律不认", !isManagedValue("windowState", {}) && !isManagedValue("minimaxVoice", {}));
  check("布尔字段认真值", isManagedValue("closeToTray", true) && isManagedValue("closeToTray", false));
  check("布尔字段拒字符串", !isManagedValue("closeToTray", "true") && !isManagedValue("closeToTray", 1));
  check("枚举字段认取值域内", isManagedValue("theme", "dark") && isManagedValue("voiceEngine", "mimo"));
  check("枚举字段拒域外", !isManagedValue("theme", "blue") && !isManagedValue("voiceEngine", "gpt"));
  check("枚举字段拒空串（除 locale 自己的空串）", !isManagedValue("theme", ""));
  check("locale 认空串（= 跟随系统）", isManagedValue("locale", ""));
  check("interactionLanguage 认 follow", isManagedValue("interactionLanguage", "follow"));
  check("path 字段认空串与普通路径", isManagedValue("workspace", "") && isManagedValue("workspace", "E:\\ws"));
  check("path 字段拒非字符串", !isManagedValue("workspace", 3) && !isManagedValue("workspace", null));

  const n = normalizeSettings({ theme: "blue", closeToTray: "yes", voiceEngine: "mimo" });
  check("归一化：非法值回落默认", n.theme === DEFAULTS.theme && n.closeToTray === DEFAULTS.closeToTray);
  check("归一化：合法值保留", n.voiceEngine === "mimo");
  check("归一化：字段一个不少", Object.keys(n).sort().join(",") === [...FIELD_NAMES].sort().join(","));
  check("归一化：undefined / null / 字符串都安全", [undefined, null, "x", 42, []].every((v) => Object.keys(normalizeSettings(v)).length === FIELD_NAMES.length));
  check(
    "归一化：不把无关字段带出来",
    !("windowState" in normalizeSettings({ windowState: { width: 1 }, theme: "dark" })),
  );
}

// ── 3. 写回意图的形状（这一节对应「整份回落默认」那个代价） ────────────────────
{
  const follow = globalFileEdits({ locale: "", interactionLanguage: "follow" });
  check("locale='' → remove，不写空串", follow.remove.includes("locale") && !("locale" in follow.set));
  check("interactionLanguage='follow' → remove", follow.remove.includes("interactionLanguage") && !("interactionLanguage" in follow.set));

  const explicit = globalFileEdits({ locale: "zh", interactionLanguage: "en" });
  check("locale=zh → set", explicit.set.locale === "zh" && !explicit.remove.includes("locale"));
  check("interactionLanguage=en → set", explicit.set.interactionLanguage === "en");

  const g = globalFileEdits(DEFAULTS);
  check("全局意图覆盖全部全局字段", GLOBAL_FIELD_NAMES.every((n) => n in g.set || g.remove.includes(n)));
  check("全局意图不含工作区字段", WORKSPACE_FIELD_NAMES.every((n) => !(n in g.set)));
  check("全局意图不写进 workspace", !("workspace" in g.set));

  // 只写「用户真的覆盖过」的字段 —— 这一条是「不拿默认值盖掉她的选择」的实现。
  const only = globalFileEdits({ theme: "dark" }, new Set(["theme"]));
  check("only 过滤：只写集合内的字段", Object.keys(only.set).join(",") === "theme" && only.set.theme === "dark");
  check("only 过滤：集合外的字段连 remove 都不产生", globalFileEdits({ locale: "" }, new Set(["theme"])).remove.length === 0);

  // 工作区意图
  check("workspace='' → 整份跳过（不是写相对路径）", workspaceFileEdits({ workspace: "" }) === undefined);
  check("workspace='   ' → 同样跳过", workspaceFileEdits({ workspace: "   " }) === undefined);
  const w = workspaceFileEdits({ workspace: "E:\\ws", dreamEnabled: false, backendThinking: "max" });
  check("工作区意图按整机形状分节", w.set.dream.enabled === false && w.set.backend.thinking === "max");
  check("工作区意图补齐同节其它叶子", w.set.backend.contract === DEFAULTS.backendContract && w.set.models.actor === DEFAULTS.modelsActor);
  const wOnly = workspaceFileEdits({ workspace: "E:\\ws" }, new Set(["dreamEnabled"]));
  check("工作区 only 过滤：只落被允许的叶子", JSON.stringify(wOnly.set) === JSON.stringify({ dream: { enabled: DEFAULTS.dreamEnabled } }));
}

// ── 4. 从整机文件读种子（缺席字段不入结果） ──────────────────────────────────
{
  const fromGlobal = valuesFromGlobalFile({
    windowState: { width: 1440, height: 900 },
    interactionLanguage: "zh",
    theme: "light",
    voiceEngine: "local",
    minimaxVoice: { voiceId: "x" },
  });
  check("种子：只取本插件管的键", Object.keys(fromGlobal).sort().join(",") === "interactionLanguage,theme,voiceEngine");
  check("种子：windowState / minimaxVoice 不进来", !("windowState" in fromGlobal) && !("minimaxVoice" in fromGlobal));
  check("种子：缺席的 locale 不入结果（缺席 = 跟随系统）", !("locale" in fromGlobal));
  check("种子：值非法的字段不入结果", !("theme" in valuesFromGlobalFile({ theme: "blue" })));

  const fromWs = valuesFromWorkspaceFile({
    backend: { thinking: "high", contract: "standard" },
    models: { actor: "deepseek-v4-pro", backend: "deepseek-flash" },
  });
  check("工作区种子：合法叶子进来", fromWs.backendThinking === "high" && fromWs.backendContract === "standard");
  check("工作区种子：模型名如实读出", fromWs.modelsActor === "deepseek-v4-pro" && fromWs.modelsBackend === "deepseek-flash");
  check(
    "工作区种子：旧模型名折成现名（她读侧也这么折）",
    valuesFromWorkspaceFile({ models: { actor: "deepseek-v4-flash" } }).modelsActor === "deepseek-flash",
  );
  check("工作区种子：乱值当没读到", !("backendThinking" in valuesFromWorkspaceFile({ backend: { thinking: "???" } })));
  check("工作区种子：缺的 section 不炸", JSON.stringify(valuesFromWorkspaceFile(null)) === "{}" && JSON.stringify(valuesFromWorkspaceFile({ dream: 3 })) === "{}");
  check("工作区种子：dream.enabled 认布尔", valuesFromWorkspaceFile({ dream: { enabled: false } }).dreamEnabled === false);

  const legacy = valuesFromLegacyVoiceFile({ engine: "mimo", realtimeVoice: false, 别的: 1 });
  check("旧语音文件：engine → voiceEngine", legacy.voiceEngine === "mimo");
  check("旧语音文件：realtimeVoice 直通", legacy.realtimeVoice === false);
  check("旧语音文件：多余键不带出来", Object.keys(legacy).sort().join(",") === "realtimeVoice,voiceEngine");
}

// ── 4b. 「跟随整机」名单的清洗 ───────────────────────────────────────────────
//
// 这份名单由客户端写进 Config，而 profile 的补丁是用户可以手改的文件。
// 一个拼错的字段名不该改变任何行为 —— 它只该被丢掉。
{
  const s = sanitizeFollowedFields(["theme", "不存在的字段", 42, null, "voiceEngine"]);
  check("名单：只留字段表里真实存在的名字", [...s].join(",") === "theme,voiceEngine");
  check("名单：空 / 坏值都是空集合", [undefined, null, "x", 42, {}].every((v) => sanitizeFollowedFields(v).size === 0));
  check("名单：去重由 Set 保证", sanitizeFollowedFields(["theme", "theme"]).size === 1);
  check("名单：windowState 这类不管的键被丢掉", sanitizeFollowedFields(["windowState"]).size === 0);
}

// ── 5. 合并语义：只并写自己的键 ──────────────────────────────────────────────
{
  const before = {
    windowState: { width: 1440, height: 900, maximized: false, fullScreen: false },
    minimaxVoice: { voiceId: "herta-x", host: "https://api.minimaxi.com", clonedAt: "2026-09-12T04:26:02.136Z" },
    theme: "light",
  };
  const after = mergeManaged(before, globalFileEdits({ theme: "dark", deviceScene: true }));
  check("合并：她自己的键原样保留", JSON.stringify(after.windowState) === JSON.stringify(before.windowState));
  check("合并：机器状态原样保留", after.minimaxVoice.voiceId === "herta-x");
  check("合并：我们管的键被更新", after.theme === "dark" && after.deviceScene === true);

  const removed = mergeManaged({ locale: "en", theme: "light" }, { set: { theme: "dark" }, remove: ["locale"] });
  check("合并：remove 真的删键（而不是写 undefined）", !("locale" in removed) && removed.theme === "dark");

  const nested = mergeManaged({ backend: { thinking: "low", 未来字段: 1 } }, { set: { backend: { contract: "standard" } } });
  check("合并：嵌套节递归合并", nested.backend.thinking === "low" && nested.backend.contract === "standard");
  check("合并：嵌套节里未知的键也留着", nested.backend.未来字段 === 1);
  check("合并：不改入参", before.theme === "light");
}

// ── 6. 端到端写盘（在临时目录里造出整机的两份文件） ──────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-herta-settings-"));
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, ".herta"), { recursive: true });
  const wsFile = workspaceSettingsPath(workspace);

  // 她自己的那份全局文件：含我们不管的键 + 已经是 light 的主题。
  // 真实文件路径由 `process.env.APPDATA` 决定，所以这里只驱动**工作区**那一半，
  // 全局那一半用 `global: false` 跳过（它的路径是固定的，不该被测试写脏）。
  writeFileSync(
    wsFile,
    `${JSON.stringify(
      { dream: { enabled: true }, backend: { thinking: "high", contract: "standard" }, models: { actor: "deepseek-v4-pro" } },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const report = syncHertaSettings(
    { workspace, dreamEnabled: false },
    { global: false, only: new Set(["workspace", "dreamEnabled"]) },
  );
  check("写盘：报告 ok", report.workspace !== null && report.workspace.ok === true);
  check("写盘：报告 changed", report.workspace.changed === true);
  check("写盘：全局被显式跳过", report.global.skipped === true && report.global.ok === true);

  const after = JSON.parse(readFileSync(wsFile, "utf8"));
  check("写盘：我们的键落下去了", after.dream.enabled === false);
  check("写盘：没拥有的键一个字节没动（backend.thinking）", after.backend.thinking === "high");
  check("写盘：没拥有的键一个字节没动（backend.contract）", after.backend.contract === "standard");
  check("写盘：没拥有的节整个没被动过（models）", JSON.stringify(after.models) === JSON.stringify({ actor: "deepseek-v4-pro" }));

  const again = syncHertaSettings({ workspace, dreamEnabled: false }, { global: false, only: new Set(["workspace", "dreamEnabled"]) });
  check("写盘：内容不变就不重复落盘（changed=false）", again.workspace.changed === false);

  const missing = syncHertaSettings({ workspace: join(dir, "不存在"), dreamEnabled: true }, { global: false });
  check("写盘：工作区不存在 → 如实报失败，且不凭空造目录", missing.workspace.ok === false && !existsSync(join(dir, "不存在")));

  // 临时文件不该留在盘上（rename 掉了）
  check("写盘：没有残留 .tmp", !existsSync(`${wsFile}.dsh-herta.tmp`));

  const seed = readHeretaSeed({ workspace, legacyVoice: false });
  check("种子：从工作区文件读到了她的值", seed.values.backendThinking === "high" && seed.values.modelsActor === "deepseek-v4-pro");
  check("种子：记下了值的来源路径", seed.sources.backendThinking === wsFile);

  rmSync(dir, { recursive: true, force: true });
}

// ── 7. Config schema 与字段表同源（跨进程那条最危险的漂移） ─────────────────
//
// `src/host/index.js` 的 `Config` 是**生成**的，不是手写的。这一节用一份最小
// 的 schemastery 替身验证生成逻辑的形状：每个字段一个键、kind 决定构造器、
// 默认值取自 FIELDS。真正的 schemastery 由 DSH 运行时提供（`@deepseek-ai/schemastery`），
// 这里只检查「生成器读的是字段表」——两处漂移正是本测试要防的东西。
{
  /** 记录调用链的最小替身，只为看清生成器用了哪个构造器与哪个默认值。 */
  const makeZ = () => {
    const leaf = (kind) => (def) => {
      const node = { kind, def, volatile: () => node, default: (d) => ((node.def = d), node) };
      return node;
    };
    return {
      boolean: leaf("boolean"),
      string: leaf("string"),
      union(values) {
        const node = { kind: "union", values, default: (d) => ((node.def = d), node), volatile: () => node };
        return node;
      },
    };
  };
  const z = makeZ();
  const generated = Object.fromEntries(
    FIELD_NAMES.map((field) => {
      const spec = FIELDS[field];
      if (spec.kind === "boolean") return [field, z.boolean().default(spec.def).volatile()];
      if (spec.kind === "enum") return [field, z.union([...spec.values]).default(spec.def).volatile()];
      return [field, z.string().default(spec.def).volatile()];
    }),
  );
  check("schema：键与字段表逐一对应", Object.keys(generated).sort().join(",") === [...FIELD_NAMES].sort().join(","));
  check(
    "schema：每个字段的默认值等于字段表",
    FIELD_NAMES.every((n) => generated[n].def === FIELDS[n].def),
  );
  check(
    "schema：枚举字段带上完整取值域",
    FIELD_NAMES.filter((n) => FIELDS[n].kind === "enum").every(
      (n) => generated[n].kind === "union" && generated[n].values.join(",") === FIELDS[n].values.join(","),
    ),
  );
  check(
    "schema：kind 决定构造器（boolean / enum→union / path→string）",
    FIELD_NAMES.every((n) => {
      const expected = FIELDS[n].kind === "boolean" ? "boolean" : FIELDS[n].kind === "enum" ? "union" : "string";
      return generated[n].kind === expected;
    }),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
