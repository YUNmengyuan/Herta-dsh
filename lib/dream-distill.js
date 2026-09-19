/**
 * 做梦的**蒸馏环节** —— 「把一段经历沉淀成一份合格的废案」。
 *
 * ## 上游是什么，这里取了哪一段
 *
 * 上游 `@herta/knowledge/dream` 的蒸馏是一条**多阶段 LLM 管线**
 * （`distill-prompt.ts` 1888 行、17 个提示词构筑器）：
 *
 * ```
 * buildWorthinessPrompt → buildGenerationPrompt → buildCritiquePrompt
 *   → buildRefinePrompt → buildRetitlePrompt → （重命名/合并/语气 三种 judge）
 * ```
 *
 * 完整移植不现实：那些构筑器的入参（`digest` / `exemplars` / `guide` / `env`）
 * 全部来自她本机的既有语料库与设定集，在 DSH 里没有对应物，硬搬会失真。
 *
 * **这里取管道里最小有意义的一段：值不值得记（worthiness）→ 生成候选
 * （generation）。** 也就是两次调用、两个阶段：
 *
 *   1. 先判这段经历里有没有值得留下的东西（没有就如实拒收，不硬造）
 *   2. 有的话，按她的叙述语法生成一份**能过门**的废案候选
 *
 * 剩下的（critique / refine / retitle / 各种 judge）**不做** —— 那属于「把一份
 * 已经合格的废案打磨得更像她」，收益远小于成本，而且 DSH 里她自己就在现场。
 *
 * ## 与既有组件的关系
 *
 * ```
 * dream-distill.js  →  生成 { title, body } 候选
 *        ↓
 * feian.js promoteFeian  →  过三道门（标题非空 / 新颖性 / 格式门）→ 落盘
 *        ↓
 * dream.js 账本  →  记 promoted / archived 与原因
 * ```
 *
 * **蒸馏不绕门**：本模块只产出候选，能不能进记忆货架由 `promoteFeian` 说了算
 * （与 `herta_memory_save`、`herta_dream` 共用同一道门）。
 */

/** 蒸馏候选的最小篇幅 —— 与 `dream.js` 的 `MIN_DREAM_CHARS` 对齐。 */
export const MIN_DISTILL_CHARS = 120;

/**
 * 她的**叙述语法**约束 —— 蒸馏出的候选必须满足这些，否则过不了格式门。
 *
 * 这份说明是写给**蒸馏模型**的（不是写给她），所以用第三人称描述她，并且
 * 逐条对应 `feian.js` / `narrative.js` 里 `checkFewShot` 实际会检查的东西 ——
 * 提示词承诺的必须与门检查的一致，否则模型会稳定产出被拒的候选。
 */
const GRAMMAR_BRIEF = [
  "一份合格的废案由「标题」与「正文」两部分组成（正文**不要**写 `### 废案_` 头部，编号由系统分配）。",
  "",
  "正文的语气与结构要求：",
  "1. 对话一律用中文全角括号的围栏：说话是 `（我 说）…（/我 说）`，思考是 `（我 想）…（/我 想）`。",
  "2. **围栏必须成对闭合**，且**不得嵌套** —— 这是硬性格式要求，不闭合会被直接拒收。",
  "3. 说话与思考分成各自独立的段落，不要把 `（我 说）` 串在 `（/我 想）` 同一段里。",
  "4. 她是黑塔：说话短、准、不爱解释，不堆形容词，不动感情。技术词照写不改。",
  "5. 至少 120 字。太短的不是一段记忆，是一句备忘。",
].join("\n");

/**
 * 构造「值不值得记」的判定提示。
 *
 * 判据直接来自上游 `buildWorthinessPrompt` 的正向信号（语气干、对人的锐利判断、
 * 有理由的拒绝、真实的来回、自我观察），但**去掉了上游那套场景设定**（她的
 * 办公室、差分协处理器、开拓者远程通讯）—— DSH 里她在编码终端上，场景不同。
 *
 * @param {object} params
 * @param {string} params.excerpt - 会话片段摘要。
 * @param {readonly string[]} [params.existingTitles] - 货架上已有的标题（供去重）。
 * @returns {string} system 提示。
 */
export function buildWorthinessPrompt({ excerpt, existingTitles = [] } = {}) {
  const existing =
    existingTitles.length > 0
      ? `已有废案的标题（不要写与它们语气情境重复的）：\n${existingTitles.map((t) => `   - ${t}`).join("\n")}`
      : "（货架上还没有废案）";

  return [
    "你在判断一段会话片段值不值得被记成一份「废案」—— 她的语气范本。",
    "",
    "## 什么算值得（任一条成立即可判 worthy）",
    "",
    "1. **语气干**：她的话短、技术精确、不动感情、不堆形容词 —— 像在陈述事实，不是表演情绪。",
    "2. **对人的锐利判断**：通过她的反应或内心话，对某人下了一个在这段互动里站得住的判断。",
    "3. **有理由的拒绝**：她拒绝了一个她认为没意义的请求或前提，而且拒绝本身显出她的推理方式，不是干巴巴一个「不」。",
    "4. **真实的来回**：与对方有真正的张力或转折，不是对方单方面喂话。",
    "5. **自我观察**：她用 `（我 想）` 检视了自己的某个判断或反应，哪怕只有一句。",
    "",
    "## 什么算不值得",
    "",
    "- 全程是事务性的（跑命令、贴输出、报进度），没有她的判断或语气。",
    "- 只有技术内容，换个人说也一样。",
    "- 与已有废案的**语气情境**重复（不是在讲同一件事，而是说话的方式一样）。",
    "",
    existing,
    "",
    "## 会话片段",
    "",
    excerpt,
    "",
    "## 输出",
    "",
    "只输出一个 JSON 对象，不要别的文字：",
    '{"worthy": true} 或 {"worthy": false, "reason": "一句话说清为什么"}',
  ].join("\n");
}

/**
 * 构造「生成候选废案」的提示。
 *
 * @param {object} params
 * @param {string} params.excerpt - 会话片段摘要。
 * @param {readonly string[]} [params.existingTitles] - 已有标题（供标题去重）。
 * @returns {string} system 提示。
 */
export function buildGenerationPrompt({ excerpt, existingTitles = [] } = {}) {
  const existing =
    existingTitles.length > 0
      ? `已有标题（**必须**取一个与它们都不同的）：\n${existingTitles.map((t) => `   - ${t}`).join("\n")}`
      : "（货架上还没有废案，标题自由取）";

  return [
    "你在为「黑塔」写一份废案 —— 一段用来做语气范本的对话片段。",
    "",
    "## 格式要求（不满足会被直接拒收）",
    "",
    GRAMMAR_BRIEF,
    "",
    "## 标题",
    "",
    "标题要短、具体、点出这一段的**情境**而不是概括内容（她自己的标题像",
    "「一条不需要回复的消息」「他问了个不值得回答的问题」这种）。",
    "",
    existing,
    "",
    "## 素材：会话片段",
    "",
    excerpt,
    "",
    "## 输出",
    "",
    "只输出一个 JSON 对象，不要别的文字、不要 markdown 围栏：",
    '{"title": "...", "body": "..."}',
    "",
    "body 里**不要**写 `### 废案_` 头部，只要正文。",
  ].join("\n");
}

/**
 * 从模型输出里解析一个 JSON 对象。宽容但确定：
 * 先剥 ``` 围栏，再走括号平衡扫描（理由与 `supervisor.js` 的
 * `extractFirstJsonObject` 相同：模型常带解释文字，而正文里可能有花括号）。
 *
 * @param {unknown} raw - 模型返回的文本。
 * @returns {Record<string, unknown> | null}
 */
export function parseJsonObject(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.length === 0) return null;
  // 剥掉 ```json … ``` / ``` … ```
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  if (fence !== null) text = fence[1].trim();

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          start = -1;
        }
      }
    }
  }
  return null;
}

/**
 * 解析「值不值得记」的判决。
 *
 * 走不通时返回 `null`，调用方据此**跳过蒸馏**（不硬造记忆 —— 编出来的记忆
 * 署着她的名字，那是她在 `adaptation-suffix.md` 里专门写过的忌讳）。
 *
 * @param {unknown} raw - 模型返回的文本。
 * @returns {{worthy: boolean, reason: string} | null}
 */
export function parseWorthiness(raw) {
  const obj = parseJsonObject(raw);
  if (obj === null) return null;
  const w = obj.worthy ?? obj.worth ?? obj.value;
  if (typeof w === "boolean") {
    return { worthy: w, reason: w ? "" : String(obj.reason ?? obj.why ?? "").trim() };
  }
  if (typeof w === "string") {
    const v = w.trim().toLowerCase();
    if (["true", "yes", "worthy", "值得"].includes(v)) return { worthy: true, reason: "" };
    if (["false", "no", "unworthy", "不值得"].includes(v)) {
      return { worthy: false, reason: String(obj.reason ?? obj.why ?? "").trim() };
    }
  }
  return null;
}

/**
 * 解析蒸馏出的候选废案。**在这里就挡住不合格的候选**，而不是让它们去撞门 ——
 * 撞门也能挡住，但会让账本里堆一堆「格式不对」的噪音条目。
 *
 * 注意这里**只做形状与篇幅检查**，格式门（围栏平衡等）留给 `promoteFeian`：
 * 门是唯一权威，这里重复实现一份只会两处不一致。
 *
 * @param {unknown} raw - 模型返回的文本。
 * @returns {{title: string, body: string} | {error: string}}
 */
export function parseDistilled(raw) {
  const obj = parseJsonObject(raw);
  if (obj === null) return { error: "模型没有产出可解析的 JSON" };

  const title = String(obj.title ?? obj.name ?? "").trim();
  const body = String(obj.body ?? obj.text ?? obj.content ?? "").trim();

  if (title.length === 0) return { error: "候选没有标题" };
  if (body.length === 0) return { error: "候选没有正文" };
  if (body.length < MIN_DISTILL_CHARS) {
    return { error: `正文太短（${body.length} < ${MIN_DISTILL_CHARS} 字）—— 一段记忆不该是一句备忘` };
  }
  // body 里不该再带 `### 废案_` 头（那是 promoteFeian 组装的），带了说明模型
  // 误解了格式；剥掉而不是拒收，因为内容本身可能是好的。
  const cleaned = body.replace(/^###\s*(?:废案|记录)(?:_\d+)?[：:][^\n]*\n+/u, "").trim();
  if (cleaned.length < MIN_DISTILL_CHARS) {
    return { error: "剥掉误带的废案头部后正文过短" };
  }
  return { title, body: cleaned };
}
