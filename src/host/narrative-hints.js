/**
 * 叙述语法与提示词资产 —— 从 Herta 上游**逐字移植**的纯函数/常量模块。
 *
 * 为什么不直接 import 上游：上游是 TypeScript + `@herta/core` 工作区依赖，
 * 而本插件要的是一个**自包含**的 `.js`（Node 能直接单测、esbuild 能原样打包，
 * 见 `src/shared/mapping.js` 同样的理由）。移植的是**文本与规则**，不是运行时。
 *
 * ## 她的叙述语法（这是原版的骨头）
 *
 * 她的每一拍是**两种表面**，各有自己的围栏：
 *
 *   （我 想）……（/我 想）        思考表面 —— 内心判断，不进用户的视野
 *   （我 说）……（/我 说）        说话表面 —— 实际说给开拓者听的话
 *
 * 这两组围栏在 zh/en 两种语言下**都是中文**（上游 thought-hint.ts:16-18：
 * 「Structural narrative-grammar tokens stay CN in BOTH variants」）—— 它们是
 * **语法记号**，不是指导语，所以不做翻译。
 *
 * ## 出处（逐字，改动为零）
 *
 * | 本文件的 | 上游 |
 * |---|---|
 * | 围栏常量 | `herta/src/narrative/thought-hint.ts:27-30` |
 * | `thoughtBeforeSpeechTag` | `herta/src/narrative/actor-turn-prompts.ts:34-40` |
 * | `buildSupervisorVetoHint` | `herta/src/narrative/thought-hint.ts:321-327` |
 * | `formatSelfCorrectionText` | `herta/src/narrative/thought-hint.ts:341-343` |
 * | `SUPERVISOR_VETO_TEMPLATE` | `herta/src/narrative/actor-hints.ts`（SUPERVISOR_VETO_TEMPLATE_TEXT.zh） |
 * | `SUPERVISOR_RETHINK/RESPEAK` | `herta/src/narrative/actor-hints.ts`（2026-07-18 两阶段） |
 * | beat 提示与 `BEAT_NO_BANZHUAN_CLAUSE` | `herta/src/narrative/thought-hint.ts:371-398` |
 *
 * **注意 `BEAT_NO_BANZHUAN_CLAUSE`**：原版说「不要在这一句里写 `@板砖` —— 板砖
 * 正在工作中」。在 DSH 里板砖（她的编码子代理）根本不接活，所以纪律更强，
 * 但**这层提示仍然逐字保留**：它约束的是叙述行为的形状，而 DSH 侧的
 * `adaptation-suffix.md` 已经另行写明「这里没有板砖」。两层提示不冲突。
 */

// ── 围栏常量（上游 thought-hint.ts:27-30）────────────────────────────────────

/** 说话表面的开围栏。 */
export const FORCED_SPEECH_OPEN_TAG = "（我 说）";
/** 说话表面的闭围栏。 */
export const STOP_SPEECH_CLOSE = "（/我 说）";
/** 思考表面的闭围栏。 */
export const STOP_THOUGHT_CLOSE = "（/我 想）";
/** 思考表面的开围栏（上游由调用方拼写，此处补成常量便于解析）。 */
export const THOUGHT_OPEN_TAG = "（我 想）";

/**
 * 从一段「思考表面」的流里取出**说话围栏之前**的部分。
 *
 * 逐字移植 `actor-turn-prompts.ts:34-40`。上游的理由（2026-06-14 的 bug）：
 * 思考流里有时会包含 `（我 说）` —— 可能因为她在思考散文里引用了这个记号，
 * 也可能因为她跳过 `（/我 想）` 直接滚进了说话。**两种情况都要把 `（我 说）`
 * 之后的内容丢弃**，否则那段「规划散文」会被当成她的台词发给用户。
 *
 * @param {string} text - 一帧思考表面的文本。
 * @returns {string} 清理后的思考文本。
 */
export function thoughtBeforeSpeechTag(text) {
  const splitIdx = String(text).indexOf(FORCED_SPEECH_OPEN_TAG);
  const thoughtPart = splitIdx < 0 ? String(text) : String(text).slice(0, splitIdx);
  return thoughtPart
    .replaceAll(STOP_THOUGHT_CLOSE, "")
    .replaceAll(THOUGHT_OPEN_TAG, "")
    .trim();
}

/**
 * 在**第一个闭围栏处截断**，丢掉围栏及其后的全部内容。
 *
 * 注意：这**不是**上游 `streaming-sink.ts` 的 `stripStopSequence` —— 那个还要
 * 处理流式分帧时闭围栏被拆成两帧的残留（`（/我` + ` 说）`），是给增量流用的。
 * 这里只需要整段文本的切分，所以刻意只保留这一种行为，也不叫那个名字，
 * 免得日后有人以为它扛得住流式分帧。
 *
 * @param {string} text - 待截断文本。
 * @param {string} close - 闭围栏。
 * @returns {string} 截断后的文本。
 */
export function truncateAtClose(text, close) {
  const s = String(text);
  const idx = s.indexOf(close);
  return idx < 0 ? s : s.slice(0, idx);
}

// ── supervisor 否决（自我收回）───────────────────────────────────────────────

/**
 * 否决原因 → 重说指令。逐字移植 `thought-hint.ts:321-327` 的**文本变换**，
 * 但补了上游没有的一道保险：模板里没有 `{{reason}}` 时**抛错**。
 *
 * 为什么补：上游的模板来自编译好的 asset，缺失时它有 fallback 链；而这里的
 * 模板是调用方传进来的，写错一个字符就会把 `{{reason}}` 原样塞进她的提示词
 * （她读到的会是一段带花括号的乱码，而且**不会报错**）。宁可当场炸。
 *
 * @param {string} template - 带 `{{reason}}` 占位符的模板。
 * @param {string} reason - supervisor 给出的否决原因。
 * @returns {string} 可直接注入的提示文本。
 * @throws {TypeError} 模板不含 `{{reason}}` 占位符时。
 */
export function buildSupervisorVetoHint(template, reason) {
  const tpl = String(template);
  if (!tpl.includes("{{reason}}")) {
    throw new TypeError(`buildSupervisorVetoHint: 模板里没有 {{reason}} 占位符：${tpl.slice(0, 40)}…`);
  }
  const trimmed = String(reason).trim().replace(/[。.!?！？]+$/u, "");
  return tpl.split("{{reason}}").join(trimmed);
}

/**
 * 否决原因 → `selfCorrection` 字段值。逐字移植 `thought-hint.ts:341-343`。
 * 序列化时会写成 `——<text>\n\n` 的散文形式，所以这里只要干净的因由文本。
 *
 * @param {string} reason - supervisor 给出的否决原因。
 * @returns {string} 去掉句末标点的因由。
 */
export function formatSelfCorrectionText(reason) {
  return String(reason).trim().replace(/[。.!?！？]+$/u, "");
}

/**
 * 一段否决：否决理由 + 重说模板。上游 default 是 zh 版，**逐字**。
 * 来源：`actor-hints.ts` 的 `SUPERVISOR_VETO_TEMPLATE_TEXT.zh`。
 */
export const SUPERVISOR_VETO_TEMPLATE =
  "〔我刚才说的话被自己回头一看就否了：{{reason}}。现在重新说一次，必须以（我 说）开始，以（/我 说）结束，针对刚才被否的那点调一下，别再犯一样的错。〕";

/**
 * 两阶段否决的第一阶段：**先重新想**（2026-07-18）。
 *
 * 逐字移植 `actor-hints.ts` 的 `SUPERVISOR_RETHINK_TEMPLATE_TEXT.zh`。
 * 里面那两条底线在 DSH 场景下依然成立、且**必须保留**：
 *   1. 「记录里真摆着的凭证不用怀疑，不用替它翻案」
 *   2. 「这个终端里动文件的一直是板砖，不是我 —— 嘴上说『我记了』『我写好了』，
 *       盘上不会因此多出一个字」
 * 第 2 条尤其重要：DSH 里她的记忆工具**确实会写盘**，但那个动作是
 * `herta_memory_save` 干的，不是她「说一声」就发生的。
 */
export const SUPERVISOR_RETHINK_TEMPLATE =
  "〔我刚才要说的那句被自己回头看否了：{{reason}}。先别急着开口——重新想一遍：那句话错在哪个点上；我刚才那套想法里有没有哪一步本身就站不住；正确的说法应该落在什么上面——是终端记录里有凭证的事，是我自己真实经历过的事，还是根本不用动事实、只该换一种口吻。想的时候两条底线别丢：记录里真摆着的凭证不用怀疑，不用替它翻案；这个终端里动文件的一直是板砖，不是我——嘴上说「我记了」「我写好了」，盘上不会因此多出一个字，没有板砖的写入行就等于没有这回事。必须以（我 想）开始，以（/我 想）结束，只想这一件事，别展开新话题。〕";

/**
 * 两阶段否决的第二阶段：**照想清楚的说**（2026-07-18）。
 * 逐字移植 `actor-hints.ts` 的 `SUPERVISOR_RESPEAK_TEXT.zh`。
 */
export const SUPERVISOR_RESPEAK =
  "〔想完了。现在照着刚才想清楚的说出来。必须以（我 说）开始，以（/我 说）结束。重说的是一次完整的回话：刚才那句话本来要回应开拓者的事，这次也要回应到位——改错的地方改掉，【没被否掉的】意思一样不少，别只把改好的那半句单独丢出来。但被否的那个说法，连同靠它撑起来的宣称，整个丢掉——不是换个说法保住，一个字都不许再出现，也不许换个名字、换个文件名再冒出来。说全不等于说长：一句话能回应完的就一句话，不用拿软话把句子填满。刚才想的里面定了要派活就写全 @板砖 真派出去，定了要承认就直说，定了要换口吻就用换好的口吻说；只说我自己的话，别替开拓者说他的。〕";

// ── 分拍（beat）提示 ─────────────────────────────────────────────────────────

/**
 * 每一拍共享的禁令子句。逐字移植 `thought-hint.ts:371-376`。
 *
 * 为什么原样保留：它约束的是**分拍不抢任务**这件事 —— 拍是对眼前这一步的
 * 即评，不是发新指令的地方。上游观察到她把「继续，@板砖——换个名」写进了
 * tool.fail 的拍里（N9，2026-05-23）。
 */
export const BEAT_NO_BANZHUAN_CLAUSE =
  "不要在这一句里写 `@板砖` —— 板砖正在工作中，新任务等它做完再说，现在只点评眼前这一步。";

/** 补丁预览后的即评。逐字移植 `thought-hint.ts:378-383`。 */
export const BEAT_HINT_PATCH_PREVIEW = `〔板砖刚把补丁亮在记录上方了。现在我说一句话点评：看 diff 的形状是不是干净 / 哪里值得提一嘴 / 有没有可疑的地方。不复述代码（开拓者自己能看见），不解释 diff 在做什么。短促、带判断。${BEAT_NO_BANZHUAN_CLAUSE}必须以（我 说）开始，以（/我 说）结束。〕`;

/** 验证步骤（测试 / 编译 / lint）跑完后的即评。逐字移植 `thought-hint.ts:385-391`。 */
export const BEAT_HINT_VERIFICATION_FINISHED = `〔板砖刚跑完了一步验证（测试 / 编译 / lint）。结果就在记录上方。现在我说一句话：过了就点一下，挂了就指出哪里挂了 / 可疑。不复述全部输出，不读 stack trace。短促、冷静。${BEAT_NO_BANZHUAN_CLAUSE}必须以（我 说）开始，以（/我 说）结束。〕`;

/** 一步失败后的即评。逐字移植 `thought-hint.ts:393-398`。 */
export const BEAT_HINT_TOOL_FAIL = `〔板砖刚一步失败了。失败原因写在记录上方。现在我说一句话：把失败点拎出来用人话讲（不要照搬错误信息），态度可以冷 / 嘲讽，但不要装作这事不要紧。一句话。${BEAT_NO_BANZHUAN_CLAUSE}必须以（我 说）开始，以（/我 说）结束。〕`;

// ── 解析：从一段文本里切出思考与说话 ─────────────────────────────────────────

/**
 * 把一段（可能跨两种表面的）文本切成思考与说话。
 *
 * 这是**我们的**解析器（上游不做单函数切分，它按 phase 分别生成），但语义
 * 完全遵循上游的围栏约定：`（我 说）` 之后的内容归说话，`（我 想）` 之内归思考，
 * 闭围栏本身不进正文。
 *
 * 边界情况刻意与上游 `thoughtBeforeSpeechTag` 对齐：**说话围栏之后不再回看**，
 * 也就是「说话段里再出现 `（我 想）`」不会被当成新的思考段 —— 上游正是为了
 * 避免这种误判才丢弃围栏之后的一切。
 *
 * @param {string} text - 一帧或一整段文本。
 * @returns {{thought: string, speech: string, hasThought: boolean, hasSpeech: boolean}}
 */
export function splitSurfaces(text) {
  const raw = String(text);
  const speechIdx = raw.indexOf(FORCED_SPEECH_OPEN_TAG);
  const thoughtIdx = raw.indexOf(THOUGHT_OPEN_TAG);

  // 形状 A：有说话围栏 —— 之前的是思考（可能空），之后的是说话。
  if (speechIdx >= 0) {
    const before = raw.slice(0, speechIdx);
    const thought = thoughtBeforeSpeechTag(before);
    const speech = truncateAtClose(
      raw.slice(speechIdx + FORCED_SPEECH_OPEN_TAG.length),
      STOP_SPEECH_CLOSE,
    ).trim();
    return {
      thought,
      speech,
      hasThought: thought.length > 0,
      hasSpeech: speech.length > 0,
    };
  }

  // 形状 B：只有思考围栏。
  if (thoughtIdx >= 0) {
    const thought = thoughtBeforeSpeechTag(raw);
    return { thought, speech: "", hasThought: thought.length > 0, hasSpeech: false };
  }

  // 形状 C：没有围栏 —— 全是说话（她没按语法来时不要把内容吞掉）。
  return { thought: "", speech: raw.trim(), hasThought: false, hasSpeech: raw.trim().length > 0 };
}
