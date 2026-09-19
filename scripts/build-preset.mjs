/**
 * 生成 herta agent preset 的 `agent.cordis.yml`。
 *
 * 做法：以随附 `standard` preset 的 `agent.cordis.yml` 为底，**只替换 persona 行**，
 * 其余（工具清单、各类 group/realm 声明）逐字保留。这样工具集永远跟随官方，
 * 不会因为我们抄漏某一行而少给或多给她能力。
 *
 * 人设映射（这是本层唯一带判断的地方）：
 *   prefix = HertaBio.txt（逐字，身份正本）+ adaptation-prefix.md（她在这台终端上的处境）
 *   suffix = adaptation-suffix.md（工具/记忆/边界纪律）+ cwd 行
 *
 * **刻意不用 `complete: true`**：那会独占系统提示词，把 B 层要挂的
 * 「活记忆」prompt 段一并憋死。
 *
 * 用法：node scripts/build-preset.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** DSH 安装里的随附 preset；可用 DSH_PRESETS 覆盖。 */
const DSH_PRESETS =
  process.env.DSH_PRESETS ??
  "E:\\DeepSeek H\\data\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-presets\\presets";
/** Herta 源码树（身份正本在这里）。 */
const HERTA_SRC = process.env.HERTA_SRC ?? "E:\\deepseek工作区\\Herta-src";

const BASE = join(DSH_PRESETS, "standard", "agent.cordis.yml");
const BIO = join(HERTA_SRC, "packages", "herta", "prompts", "HertaBio.txt");
const ADAPT_PREFIX = join(root, "preset", "adaptation-prefix.md");
const ADAPT_SUFFIX = join(root, "preset", "adaptation-suffix.md");
const OUT = join(root, "preset", "agent.cordis.yml");

for (const p of [BASE, BIO, ADAPT_PREFIX, ADAPT_SUFFIX]) {
  if (!existsSync(p)) throw new Error(`缺文件：${p}`);
}

/** 把任意文本渲染成 YAML 块标量，并缩进到指定层级。 */
function blockScalar(text, indent) {
  const pad = " ".repeat(indent);
  const body = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return body
    .split("\n")
    .map((line) => (line === "" ? "" : pad + line))
    .join("\n");
}

const bio = readFileSync(BIO, "utf8");
const adaptPrefix = readFileSync(ADAPT_PREFIX, "utf8");
const adaptSuffix = readFileSync(ADAPT_SUFFIX, "utf8");
const base = readFileSync(BASE, "utf8");

// ── 定位并替换 persona 行 ──────────────────────────────────────────────────
const lines = base.split("\n");
const start = lines.findIndex((l) => /^- id: persona\s*$/.test(l));
if (start < 0) throw new Error("在底本里没找到 `- id: persona` 行 —— 上游改了写法，需要更新本脚本");

let end = start + 1;
while (end < lines.length) {
  const line = lines[end];
  // 下一个顶层列表项，或段落分隔注释，都算 persona 行的结束
  if (/^- /.test(line) || /^# ──/.test(line)) break;
  end += 1;
}

const personaBlock = [
  "# ── 身份 ────────────────────────────────────────────────────────────────────",
  "# 她的自传是逐字搬来的身份正本（Herta-src/packages/herta/prompts/HertaBio.txt），",
  "# 后面接一段为 DSH 改写的处境说明 —— 原版里「板砖」是独立的编码子代理、由她 @ 调用，",
  "# 而 DSH 把工具直接放在她手上，机制不同，不能照抄。",
  "#",
  "# 刻意不用 complete: true —— 那会独占系统提示词，导致 B 层的活记忆段被一并抑制。",
  "- id: persona",
  "  name: '@deepseek-ai/dsh-persona'",
  "  config:",
  "    prefix: |-",
  blockScalar(bio, 6),
  "",
  blockScalar(adaptPrefix, 6),
  "    suffix: |-",
  blockScalar(adaptSuffix, 6),
  "",
  "      Your working directory is {{cwd}}.",
].join("\n");

const replaced = [...lines.slice(0, start), personaBlock, ...lines.slice(end)].join("\n");

// ── 追加 dsh-herta 行（agent 面）─────────────────────────────────────────
// `plane: preset` 是给插件的平面标记：同一份代码也在 profile bundle 里挂了
// 一行（宿主面），那一行只负责让界面进启动图；**只有带了标记的这一行**
// 才注册她的记忆货架段与记忆工具，从而只作用于她的会话。
const withHerta = `${replaced.replace(/\n+$/, "")}

# ── dsh-herta（agent 面）────────────────────────────────────────────────────
# 宿主面那一行在 profile bundle 里，负责界面；这一行负责她的工具与提示词段。
# 两行同 id 是合法的：loader 的条目 id 按 EntryTree 独立，而 preset 是一棵
# 独立的子树（mount.ts 的 PresetTree 会把自己的 subtree 槽删掉，
# 根树的 entries() 遍历不到它）。
- id: herta
  name: dsh-herta
  config:
    plane: preset
`;

mkdirSync(join(root, "preset"), { recursive: true });
writeFileSync(OUT, withHerta, "utf8");

const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1);
console.log(`底本        ${BASE}`);
console.log(`身份正本    HertaBio.txt（${kb(bio)} KB，逐字）`);
console.log(`处境改写    adaptation-prefix.md（${kb(adaptPrefix)} KB）`);
console.log(`纪律改写    adaptation-suffix.md（${kb(adaptSuffix)} KB）`);
console.log(`persona 行  原 ${end - start} 行 → 新 ${personaBlock.split("\n").length} 行`);
console.log(`已写出      ${OUT}（${kb(withHerta)} KB，共 ${withHerta.split("\n").length} 行）`);
