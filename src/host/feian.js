/**
 * 废案的格式与晋升规则。
 *
 * 抽出来是因为**两条写入路径必须共用同一套规则**：`herta_memory_save`（她直接记一笔）
 * 与 `herta_dream`（做梦晋升）。规则分叉的话，做梦那条就会绕开格式门。
 *
 * `titleNoveltyOk` / `normalizeTitle` 逐字移植自
 * `Herta-src/packages/knowledge/src/dream/novelty.ts`（45 行，自包含）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NARRATIVE_REL, checkFewShot, estimatePromptTokens, readNarrative } from "./narrative.js";

// ── 标题新颖性（移植自 novelty.ts）────────────────────────────────────────
// 「（其一）（其二）」这类连载后缀不参与比较：同一底名的连续篇是允许的。

const SERIES_SUFFIX = /（其[一二三四五六七八九十百零〇\d]+）\s*$/;

/** 文件名里会被替换掉的字符集，与写入时的消毒保持一致。 */
const FILENAME_SANITIZED = /[/\\:*?"<>|]/g;

/**
 * 归一化标题用于**比较**（不改变存储值）。
 *
 * 大小写折叠只用于比较：上游踩过的坑是 `Unix/Windows 的抉择` 在文件名里被消毒成
 * `Unix_Windows…`，之后同一个候选因比较不相等而通过了标题预筛。所以这里把
 * 文件名的消毒规则也折进归一化，两边用同一把尺子。对中文是恒等变换。
 */
export function normalizeTitle(title) {
  return title
    .replace(SERIES_SUFFIX, "")
    .replace(FILENAME_SANITIZED, "_")
    .trim()
    .toLowerCase();
}

/** 连载篇（（其N））豁免：同底名允许重复。 */
function isSeriesOf(a, b) {
  return SERIES_SUFFIX.test(a) && SERIES_SUFFIX.test(b) && normalizeTitle(a) === normalizeTitle(b);
}

/**
 * 标题与现有货架是否足够不同。
 * 只挡**标题碰撞**——内容层面的相似度判断属于模型，不属于这道便宜的门。
 */
export function titleNoveltyOk(title, existingTitles) {
  const norm = normalizeTitle(title);
  for (const e of existingTitles) {
    if (isSeriesOf(title, e)) continue;
    if (normalizeTitle(e) === norm) return false;
  }
  return true;
}

/** 从货架文件名里抽出标题：`### 废案_07：一条不需要回复的消息.txt` → `一条不需要回复的消息`。 */
export function titlesOf(files) {
  const out = [];
  for (const name of files) {
    const m = /^###\s*(?:废案|记录)(?:_\d+)?[：:]\s*(.+)\.txt$/.exec(name);
    if (m !== null) out.push(m[1]);
  }
  return out;
}

/** 下一个空闲编号。编号零填充，字典序即编号序。 */
export function nextFeianNumber(files) {
  let next = 0;
  for (const name of files) {
    const m = /^### 废案_(\d{2})/.exec(name);
    if (m !== null) next = Math.max(next, Number(m[1]) + 1);
  }
  return String(next).padStart(2, "0");
}

/** 文件名里不能出现的字符 → `_`（与 novelty.ts 的消毒规则同一套）。 */
export function safeTitleForFilename(title) {
  return title.replace(FILENAME_SANITIZED, "_").trim();
}

/**
 * 组装一份废案的完整文本 —— 与她本人写的形态完全同构：
 * 首行 `### 废案_NN：<标题>`，空行，正文。
 */
export function composeFeian(nn, title, body) {
  return `### 废案_${nn}：${title}\n\n${String(body).trim()}\n`;
}

/**
 * 晋升一份废案到货架 —— 两条写入路径的唯一入口。
 *
 * 依次过三道关，**任一道不过就拒写并给出原因**（不抛错：拒写是一个正常结果，
 * 模型需要拿到原因才能改一版重试，这正是她真实做梦账本里
 * 「invalid after refine: bad header」那些条目的形态）：
 *
 *   1. 格式门（复用 `checkFewShot`，与读取端同一道）
 *   2. 标题新颖性（与现有货架比）
 *   3. 写入
 *
 * @param cwd - 会话工作区根。
 * @param input - `{ title, body }`。
 * @returns `{ saved, name, path, tokens, reason? }`。
 */
export async function promoteFeian(cwd, input) {
  const title = String(input.title ?? "").trim();
  const body = String(input.body ?? "");
  if (title === "") return { saved: false, name: "", path: "", tokens: 0, reason: "标题是空的" };

  const before = await readNarrative(cwd);

  // 1) 新颖性：先比标题，便宜且能挡住绝大多数重复
  if (!titleNoveltyOk(title, titlesOf(before.files))) {
    return {
      saved: false,
      name: "",
      path: "",
      tokens: 0,
      reason: `货架上已有一份同名废案（归一化后相同）：${title}`,
    };
  }

  // 2) 格式门：组装成最终形态后再验，验的就是将要落盘的那份文本
  const nn = nextFeianNumber(before.files);
  const name = `### 废案_${nn}：${safeTitleForFilename(title)}.txt`;
  const text = composeFeian(nn, title, body);
  const check = checkFewShot(name, text);
  if (!check.ok) {
    return { saved: false, name: "", path: "", tokens: 0, reason: check.reason ?? "未通过格式门" };
  }

  // 3) 落盘
  const dir = join(cwd, NARRATIVE_REL);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return { saved: true, name, path, tokens: estimatePromptTokens(check.body) };
}

/** 读一份已落盘废案的原文（给 dream 的新颖性复核等用）。 */
export async function readFeian(cwd, name) {
  return readFile(join(cwd, NARRATIVE_REL, name), "utf8");
}
