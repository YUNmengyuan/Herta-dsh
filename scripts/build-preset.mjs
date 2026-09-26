/**
 * 生成 herta 的 agent preset 补丁层：`preset/herta.patch.yml`。
 *
 * ## 为什么整个重写（0.1.5-rc.2 → 0.1.7-rc.2）
 *
 * 旧版 preset 是 `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`（一整棵 cordis 树）
 * 外加一份 `preset.yml` 元数据。**0.1.7 起这套目录机制被完全移除**
 * （全运行时里已经没有任何代码引用 `.agent-presets`）。
 *
 * 现在的 preset 就是**一条普通的 loader 行**：
 *
 *   - id: preset-herta
 *     name: '@deepseek-ai/dsh-agent-preset'
 *     config:
 *       id: herta
 *       name: 黑塔
 *       order: 5
 *       plugins: [ ...子插件清单... ]
 *
 * 官方把随附的 standard / ptc / minimal / cordis 四份直接写成 `dsh-web-app` 的
 * bundle patch ——`package.json` 的 `dsh.bundle.patch` 现在**可以是数组**：
 *
 *   "patch": ["./cordis.patch.yml", "./presets/standard.patch.yml", ...]
 *
 * 所以本包照做：preset 作为**第二条 bundle patch** 随插件一起装，不再需要把
 * preset 拷进 `$DSH_HOME`。`scripts/install-web.mjs` 因此也少了一整步。
 *
 * ## 底本与替换策略（与原版一致）
 *
 * 以官方 `standard` 为底，**只替换 persona 行**，其余（工具清单、group/realm
 * 声明、`!!js` 表达式）逐字保留 —— 这样工具集永远跟随官方，不会因为我们抄漏
 * 一行而少给或多给她能力。
 *
 * 用**行级手术**而不是 YAML 解析：底本里带 `!!js` 自定义标签（loader 的表达式
 * 求值），通用 YAML 解析器不认它，而 `parseDocument` 那条路要求构建机装 `yaml`。
 * 底本的嵌套层级是稳定的（plugins 行固定 8 空格，插件行固定 10 空格），手术点
 * 只有 4 处，且每一步都带断言，上游改写法会**当场报错**而不是静默产出坏文件。
 *
 * 人设映射（本层唯一带判断的地方）：
 *   prefix = HertaBio.txt（逐字，身份正本）+ adaptation-prefix.md（她在这台终端上的处境）
 *   suffix = adaptation-suffix.md（工具/记忆/边界纪律）+ cwd 行
 *
 * **刻意不用 `complete: true`**：那会独占系统提示词，把 B 层要挂的
 * 「活记忆」prompt 段一并憋死。
 *
 * 用法：node scripts/build-preset.mjs
 *   DSH_PACKAGES=<…/node_modules/@deepseek-ai>  覆盖底本所在安装
 *   HERTA_SRC=<Herta 源码树>                     覆盖身份正本来源
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** Herta 源码树（身份正本在这里）。 */
const HERTA_SRC = process.env.HERTA_SRC ?? "E:\\deepseek工作区\\HerTa\\Herta-src";

/**
 * 定位一份 DSH 安装里的 `@deepseek-ai` 包目录。
 *
 * 构建期需要读官方随附的 `standard.patch.yml`。运行时那份可能在 Electron 的
 * `app.asar` 里（普通 Node 读不到），所以这里走「显式覆盖 + 常见位置探测」，
 * 探测不到就明确报错并告诉用户设哪个变量 —— 不猜、不静默降级。
 *
 * @returns {string} 含 `dsh-web-app/presets/standard.patch.yml` 的目录。
 */
function detectDshPackages() {
  const probe = (dir) =>
    dir !== undefined &&
    dir !== "" &&
    existsSync(join(dir, "dsh-web-app", "presets", "standard.patch.yml"));

  const candidates = [];
  if (process.env.DSH_PACKAGES !== undefined) candidates.push(process.env.DSH_PACKAGES);

  // 从仓库往上找 node_modules/@deepseek-ai（把插件装进某个 profile 时常见）
  let dir = root;
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(dir, "node_modules", "@deepseek-ai"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 本机已知的解包位置。**这两条是机器事实、不是契约**：桌面应用把整棵
  // `dsh` 打进 `resources\app.asar`（裸 Node 读不进去），而 profile 的
  // `node_modules/@deepseek-ai` 只是指向上游的 junction —— 上游换位置或卸载之后
  // 它们就断了。所以本机用的是解包出来的那份 0.1.7-rc.2 运行时（`dsh-017`）。
  // 换机器 / 换版本时请设 `$env:DSH_PACKAGES`。
  candidates.push("E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\@deepseek-ai");
  candidates.push("E:\\DeepSeek H\\data\\runtime\\dsh\\node_modules\\@deepseek-ai");

  for (const c of candidates) {
    if (probe(c)) return c;
  }
  throw new Error(
    [
      "找不到 DSH 安装里的 @deepseek-ai 包目录（需要它自带的 dsh-web-app/presets/standard.patch.yml 作底本）。",
      "请显式指定，例如：",
      '  $env:DSH_PACKAGES = "C:\\path\\to\\dsh\\node_modules\\@deepseek-ai"',
      "试过这些位置：",
      ...candidates.map((c) => `  ${c}`),
    ].join("\n"),
  );
}

const DSH_PACKAGES = detectDshPackages();

const BASE = join(DSH_PACKAGES, "dsh-web-app", "presets", "standard.patch.yml");
const BIO = join(HERTA_SRC, "packages", "herta", "prompts", "HertaBio.txt");
const ADAPT_PREFIX = join(root, "preset", "adaptation-prefix.md");
const ADAPT_SUFFIX = join(root, "preset", "adaptation-suffix.md");
const OUT = join(root, "preset", "herta.patch.yml");

for (const p of [BASE, BIO, ADAPT_PREFIX, ADAPT_SUFFIX]) {
  if (!existsSync(p)) throw new Error(`缺文件：${p}`);
}

/** preset 在 loader 里的行 id / config.id / 显示信息。集中在这里，改一处即可。 */
const PRESET = {
  entryId: "preset-herta",
  id: "herta",
  name: "黑塔",
  description:
    "黑塔本人 —— 天才俱乐部#83。说话短、准、不爱解释，对蠢问题缺乏耐心。带她自己的人格正本与记忆纪律。",
  order: 5,
};

/** 插件行缩进（底本里 `- id: persona` 是 10 空格）。 */
const ROW_INDENT = " ".repeat(10);
/** persona 的 config 键缩进（比行多 4）。 */
const CFG_INDENT = " ".repeat(14);

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
let base = readFileSync(BASE, "utf8").replace(/\r\n/g, "\n");

// ── 1) 换掉 preset 的身份行 ────────────────────────────────────────────────
const STANDARD_ENTRY = "    - id: preset-standard";
if (!base.includes(STANDARD_ENTRY)) {
  throw new Error(`底本里没找到 \`${STANDARD_ENTRY.trim()}\` —— 上游改了写法，需要更新本脚本`);
}
base = base.replace(STANDARD_ENTRY, `    - id: ${PRESET.entryId}`);

const STANDARD_ID = "        id: standard";
if (!base.includes(STANDARD_ID)) {
  throw new Error("底本里没找到 `        id: standard` —— 上游改了写法，需要更新本脚本");
}
base = base.replace(
  STANDARD_ID,
  [
    `        id: ${PRESET.id}`,
    `        name: ${PRESET.name}`,
    `        description: ${PRESET.description}`,
  ].join("\n"),
);

const ORDER_RE = /^ {8}order: \d+$/m;
if (!ORDER_RE.test(base)) {
  throw new Error("底本里没找到 preset 的 `        order: <n>` —— 上游改了写法，需要更新本脚本");
}
base = base.replace(ORDER_RE, `        order: ${PRESET.order}`);

// ── 2) 替换 persona 行 ─────────────────────────────────────────────────────
const lines = base.split("\n");
const start = lines.findIndex((l) => l === `${ROW_INDENT}- id: persona`);
if (start < 0) {
  throw new Error(
    "在底本里没找到 `          - id: persona` 行 —— 上游改了写法，需要更新本脚本",
  );
}

/** 一行的前导空格数（空行按 -1 处理，表示「不缩进」，由调用方决定怎么办）。 */
function indentOf(line) {
  if (line.trim() === "") return -1;
  return line.length - line.trimStart().length;
}

let end = start + 1;
while (end < lines.length) {
  const line = lines[end];
  // 下一个同级插件行 → persona 行结束
  if (line.startsWith(`${ROW_INDENT}- `)) break;
  // 空行与注释留在块内；真正的结束信号是缩进浅于插件行（离开 plugins 列表）
  if (indentOf(line) >= 0 && indentOf(line) < ROW_INDENT.length) break;
  end += 1;
}
if (end === start + 1) {
  throw new Error("persona 行是空的 —— 底本结构异常");
}

const personaBlock = [
  `${ROW_INDENT}# ── 身份 ──────────────────────────────────────────────────────────────────`,
  `${ROW_INDENT}# 她的自传是逐字搬来的身份正本（Herta-src/packages/herta/prompts/HertaBio.txt），`,
  `${ROW_INDENT}# 后面接一段为 DSH 改写的处境说明 —— 原版里「板砖」是独立的编码子代理、由她 @ 调用，`,
  `${ROW_INDENT}# 而 DSH 把工具直接放在她手上，机制不同，不能照抄。`,
  `${ROW_INDENT}#`,
  `${ROW_INDENT}# 刻意不用 complete: true —— 那会独占系统提示词，导致 B 层的活记忆段被一并抑制。`,
  `${ROW_INDENT}- id: persona`,
  `${ROW_INDENT}  name: '@deepseek-ai/dsh-persona'`,
  `${ROW_INDENT}  config:`,
  `${CFG_INDENT}prefix: |-`,
  blockScalar(bio, CFG_INDENT.length + 2),
  "",
  blockScalar(adaptPrefix, CFG_INDENT.length + 2),
  `${CFG_INDENT}suffix: |-`,
  blockScalar(adaptSuffix, CFG_INDENT.length + 2),
  "",
  `${CFG_INDENT}  Your working directory is {{cwd}}.`,
].join("\n");

const withPersona = [...lines.slice(0, start), personaBlock, ...lines.slice(end)];

// ── 3) 把 dsh-herta 的 agent 面行插进 plugins 末尾 ─────────────────────────
// 插件行缩进必须 ≥ 10，且要留在 plugins 序列里（不能跑到文档之外）。
// 所以插在 **plugins 列表的最后一行之后** —— 注意要取「最后一行仍属于该列表的
// 行」，而不是「最后一个 `- id:` 行」：最后一条插件自己的 name/disabled 等
// 续行也要算进去，否则会把那条插件拦腰截断。
let last = withPersona.length - 1;
while (last >= 0 && indentOf(withPersona[last]) < ROW_INDENT.length) last -= 1;
if (last < 0) {
  throw new Error("底本的 plugins 列表是空的 —— 上游改了写法，需要更新本脚本");
}

const hertaRow = [
  "",
  `${ROW_INDENT}# ── dsh-herta（agent 面）──────────────────────────────────────────────────`,
  `${ROW_INDENT}# 宿主面那一行在 profile bundle 里，负责让界面进启动图；这一行负责她的`,
  `${ROW_INDENT}# 提示词段与五个工具。两行同 id 是合法的：loader 条目 id 按 EntryTree 独立，`,
  `${ROW_INDENT}# 而 preset 是 @deepseek-ai/dsh-agent-preset 自己的一棵子树。`,
  `${ROW_INDENT}- id: herta`,
  `${ROW_INDENT}  name: dsh-herta`,
  `${ROW_INDENT}  config:`,
  `${ROW_INDENT}    plane: preset`,
];

const out = [
  ...withPersona.slice(0, last + 1),
  ...hertaRow,
  ...withPersona.slice(last + 1),
].join("\n");

const withHeader = `# 本文件由 scripts/build-preset.mjs 生成，请勿手改。
# 底本：${BASE}
# 结构：一条 \`@deepseek-ai/dsh-agent-preset\` 行，作为本包的第二条 bundle patch
# （见 package.json 的 dsh.bundle.patch 数组）随插件一起装。
${out.replace(/\n+$/, "")}
`;

mkdirSync(join(root, "preset"), { recursive: true });
writeFileSync(OUT, withHeader, "utf8");

const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1);
console.log(`DSH 安装    ${DSH_PACKAGES}`);
console.log(`底本        ${BASE}`);
console.log(`身份正本    HertaBio.txt（${kb(bio)} KB，逐字）`);
console.log(`处境改写    adaptation-prefix.md（${kb(adaptPrefix)} KB）`);
console.log(`纪律改写    adaptation-suffix.md（${kb(adaptSuffix)} KB）`);
console.log(`persona 行  原 ${end - start} 行 → 新 ${personaBlock.split("\n").length} 行`);
console.log(
  `已写出      ${OUT}（${kb(withHeader)} KB，共 ${withHeader.split("\n").length} 行）`,
);
