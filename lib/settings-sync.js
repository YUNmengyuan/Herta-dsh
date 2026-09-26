/**
 * 「黑塔·整机」设置的**写回** —— 把插件 Config 里的值落到整机自己读的文件里。
 *
 * ## 数据流（唯一真相在上游）
 *
 * ```
 * DSH 设置页 ──► profile/cordis.patch.yml 的 herta 条目   ← 唯一真相
 *                      │
 *                      ▼   loader 把新值提交进 volatile 引用
 *                src/host/index.js 的 loader/volatile-update
 *                      │
 *                      ▼   syncHertaSettings(values)
 *                ├─ %APPDATA%\Herta\settings.json        （只并写我们管的键）
 *                └─ <workspace>\.herta\settings.json      （同上；workspace 为空则跳过）
 * ```
 *
 * 整机（`Herta.exe`）从头到尾**不知道 DSH 存在** —— 它照旧读自己那两份文件。
 *
 * ## 三条不变量（都由本文件负责）
 *
 * 1. **只并写我们管的键**。读-改-写：先读盘上的当前对象，只覆盖
 *    `settings-schema.js` 声明的字段，其余键（`windowState`、`minimaxVoice`…）
 *    原样保留。整机自己按 debounce 写这两份文件，无条件覆盖会把它的窗口几何抹掉。
 * 2. **原子落盘**。临时文件 + `rename`，读方永远看不到半截 JSON。
 *    沿用整机 `atomic-write.ts` 的语义（同目录临时文件、rename）。
 * 3. **永不抛错**。任何一步失败都只回一条状态 —— 写不进整机的文件
 *    是「这个设置没能同步过去」，不该把插件挂载或设置页拖垮。
 *
 * ## 为什么用同步 IO
 *
 * 这两份文件都在 KB 级，而写入的触发点是「用户在设置页点了一下」或「配置热更新」，
 * 都不是热路径。同步写换来的是**天然串行**：不存在两次写交错、也不存在
 * 「后一次读到的还是前一次写之前的盘上内容」。异步写要在插件里自己接一条队列，
 * 而那条队列是纯粹的复杂度负担 —— 这里没有值得并发的东西。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  globalFileEdits,
  normalizeSettings,
  valuesFromGlobalFile,
  valuesFromLegacyVoiceFile,
  valuesFromWorkspaceFile,
  workspaceFileEdits,
} from "./settings-schema.js";

/** 整机在 Electron 里的应用名（`app.getPath('userData')` 的末段）。 */
export const HERTA_APP_DIR_NAME = "Herta";

/** 工作区偏好所在的那层目录（整机自己定的名字：`<workspace>/.herta/`）。 */
export const HERTA_WORKSPACE_DIR_NAME = ".herta";

/**
 * 整机的 userData 目录 —— 等价于 Electron 的 `app.getPath('userData')`。
 *
 * 逐平台复刻，因为写错一个目录的症状是「设置存下去了，但她看不到」，
 * 而那种错从日志里几乎看不出来。
 *
 * @returns {string}
 */
export function hertaUserDataDir() {
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(roaming, HERTA_APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", HERTA_APP_DIR_NAME);
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, HERTA_APP_DIR_NAME);
}

/** 整机全局设置文件。 */
export function globalSettingsPath() {
  return join(hertaUserDataDir(), "settings.json");
}

/**
 * 某个工作区的整机设置文件。
 *
 * @param {string} root - 工作区根目录（绝对路径）。
 * @returns {string}
 */
export function workspaceSettingsPath(root) {
  return join(root, HERTA_WORKSPACE_DIR_NAME, "settings.json");
}

/** 本插件自持的旧语音偏好文件（`$DSH_HOME/dsh-herta-voice.json`）。 */
export function legacyVoiceSettingsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "dsh-herta-voice.json");
}

/**
 * 读一个 JSON 对象。缺失、坏掉、不是对象，一律 `undefined`（**不抛**）。
 *
 * @param {string} path - 文件路径。
 * @returns {Record<string, unknown> | undefined}
 */
export function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 原子写一个 JSON 对象：同目录临时文件 → `rename`。
 *
 * `rename` 在同一文件系统上是原子的，所以读方要么看到旧内容、要么看到新内容。
 * 目录不存在就建（整机第一次写之前，`Herta/` 可能还不存在）。
 *
 * @param {string} path - 目标文件。
 * @param {unknown} value - 要写的内容（会被 JSON 序列化）。
 * @throws 写盘失败时抛出（由调用方决定怎么报告）。
 */
export function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.dsh-herta.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** 是不是「可以安全并写的普通对象」。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 把写回意图并到盘上的对象上（**纯函数**：不改入参，返回新对象）。
 *
 * `set` 走递归合并而不是整键替换：整机的工作区设置是嵌套的
 * （`{backend:{thinking,contract}}`），整键替换会把同一节里我们没管的键抹掉。
 * 今天我们管着那些节的每一个键，但那是**当下的巧合**，不是契约 ——
 * 上游加一个 `backend.xxx` 的那天，合并语义才是对的那一种。
 *
 * @param {Record<string, unknown>} target - 盘上读到的当前对象（可为空对象）。
 * @param {{set?: Record<string, unknown>, remove?: readonly string[]}} edits - 写回意图。
 * @returns {Record<string, unknown>} 合并后的新对象。
 */
export function mergeManaged(target, edits) {
  const base = isPlainObject(target) ? target : {};
  const out = { ...base };
  for (const key of edits.remove ?? []) delete out[key];
  for (const [key, value] of Object.entries(edits.set ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeManaged(out[key], { set: value }) : value;
  }
  return out;
}

/**
 * 把设置值写回整机的两份文件。
 *
 * `only` 是本文件最容易被忽略、却最要紧的参数：**只写用户真的在 DSH 里覆盖过的
 * 字段**。没被覆盖的字段（例如她只在自己应用里设过、DSH 里从没碰过）原样留在
 * 文件里，我们连默认值都不写 —— 否则第一次挂载就会拿 schema 默认把她所有
 * 选择抹平，而那种「设置被重置了」的故障从现象上根本看不出是谁干的。
 *
 * @param {unknown} values - 设置值（未归一也可，内部会归一）。
 * @param {{workspace?: string, global?: boolean, only?: Iterable<string>}} [options]
 *   覆盖项；`workspace` 默认取设置里的工作区字段，传 `""` 可强制跳过工作区写回。
 * @returns {{global: {ok: boolean, path: string, changed: boolean, skipped?: boolean, error?: string},
 *   workspace: {ok: boolean, path: string, changed: boolean, error?: string} | null}}
 *   每一步的结果都如实报告 —— 调用方（和后来排障的人）靠它判断「到底写没写进去」。
 */
export function syncHertaSettings(values, options = {}) {
  const v = normalizeSettings(values);
  const workspaceRoot = options.workspace !== undefined ? options.workspace : v.workspace;
  // `global: false` 只为测试与「只想同步工作区」的场景存在；正常路径不传。
  const report = {
    global:
      options.global === false
        ? { ok: true, path: globalSettingsPath(), changed: false, skipped: true }
        : writeOne(globalSettingsPath(), globalFileEdits(v, options.only)),
    workspace: null,
  };

  const workspaceEdits = workspaceFileEdits({ ...v, workspace: workspaceRoot }, options.only);
  if (workspaceEdits !== undefined) {
    const root = String(workspaceRoot).trim();
    // 工作区根不存在就**不写**：写下去会凭空造出 `<随便一个路径>/.herta/`，
    // 而那种目录没人会想到去删。宁可报告失败。
    if (!isDirectory(root)) {
      report.workspace = { ok: false, path: workspaceSettingsPath(root), changed: false, error: "工作区目录不存在" };
    } else {
      report.workspace = writeOne(workspaceSettingsPath(root), workspaceEdits);
    }
  }
  return report;
}

/** 一个目录真的存在。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 写一份文件并回报结果；任何异常都变成 `error` 字符串。 */
function writeOne(path, edits) {
  const before = readJsonObject(path);
  try {
    const next = mergeManaged(before ?? {}, edits);
    const changed = JSON.stringify(next) !== JSON.stringify(before ?? {});
    if (changed) writeJsonAtomic(path, next);
    return { ok: true, path, changed };
  } catch (error) {
    return { ok: false, path, changed: false, error: String(error?.message ?? error) };
  }
}

/**
 * 读整机**当前**的设置值，用于首次种子（把用户已经选好的东西搬进来）。
 *
 * 顺序上后者覆盖前者，因为语音那个文件是本插件自持的、比整机文件更权威
 * （它就是我们上一版写的）。
 *
 * @param {{workspace?: string, legacyVoice?: boolean}} [options]
 * @returns {{values: Record<string, unknown>, sources: Record<string, string>}}
 */
export function readHeretaSeed(options = {}) {
  const values = {};
  const sources = {};
  const take = (partial, path) => {
    for (const [key, value] of Object.entries(partial)) {
      values[key] = value;
      sources[key] = path;
    }
  };

  const globalPath = globalSettingsPath();
  take(valuesFromGlobalFile(readJsonObject(globalPath)), globalPath);

  if (typeof options.workspace === "string" && options.workspace.trim() !== "") {
    const wsPath = workspaceSettingsPath(options.workspace.trim());
    take(valuesFromWorkspaceFile(readJsonObject(wsPath)), wsPath);
  }

  if (options.legacyVoice !== false) {
    const legacyPath = legacyVoiceSettingsPath();
    const legacy = readJsonObject(legacyPath);
    if (legacy !== undefined) take(valuesFromLegacyVoiceFile(legacy), legacyPath);
  }
  return { values, sources };
}

/**
 * 读旧的语音偏好文件（`$DSH_HOME/dsh-herta-voice.json`），映射成设置值。
 *
 * 单独成一个函数是为了让**读**与**改名**能分开摆放：`apply` 里先读、再改名，
 * 顺序反了就等于「把要迁移的东西先搬走」。读不到就是空对象，不抛。
 *
 * @returns {Record<string, unknown>}
 */
export function readLegacyVoiceValues() {
  return valuesFromLegacyVoiceFile(readJsonObject(legacyVoiceSettingsPath()));
}

/**
 * 把旧的语音偏好文件标记为已迁移。
 *
 * 为什么是**改名**而不是删除：迁移是单向的，但「值到底有没有搬过去」这件事
 * 出问题时需要能查。改名成 `.imported` 沿用 DSH 自己的约定
 * （`settings.yaml` → `settings.yaml.imported`，见 `dsh-settings` 的 `importLegacyDocument`），
 * 既让它不再被读，又把内容留在了原地。
 *
 * @returns {{imported: boolean, path: string, nextPath?: string, error?: string}}
 */
export function markLegacyVoiceFileImported() {
  const path = legacyVoiceSettingsPath();
  if (!existsSync(path)) return { imported: false, path };
  const nextPath = `${path}.imported`;
  try {
    renameSync(path, nextPath);
    return { imported: true, path, nextPath };
  } catch (error) {
    // 改不动就**不删**它：宁可下次再试，也不要丢掉用户的选择。
    return { imported: false, path, error: String(error?.message ?? error) };
  }
}
