/**
 * 从会话表面取出复核需要的东西：**她的候选回话** + 近期记录摘要。
 *
 * 拆成注入式的纯函数（`nodes` + `eventAt` 由调用方给），目的是**可单测**：
 * 从会话表面里挑「最后一条 assistant 回话」这件事的边界（工具结果排在后面、
 * 表面为空、事件缺失、内容块不是文本……）在 lab 里很难构造，在测试里很容易。
 *
 * 依据（`@deepseek-ai/dsh-session`）：
 *   · `session.surface.nodes` —— 当前表面的 seq 列表，**模型可见顺序**
 *   · `session.eventAt(seq)` —— 按 seq 取不可变事件
 *   · `session.deriveEventMessage(event)` —— 事件 → 模型消息（工具结果的重写也归它管）
 */

/** 取纯文本：只认 `text` 块 —— 与 `src/shared/mapping.js` 的 `textOf` 同一口径。 */
function textOfBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * 沿表面从后往前找**最后一条 assistant 回话**。
 *
 * 为什么要从后往前扫而不是只取最后一个节点：表面上的最后几项很可能是
 * 工具结果（`tool result` 也是 user 角色的消息），而她刚说的话在它们前面。
 * 复核的对象必须是**她说的话**，不是工具输出。
 *
 * @param {object} params
 * @param {readonly number[]} params.nodes - `session.surface.nodes`。
 * @param {(seq: number) => object | undefined} params.eventAt - `session.eventAt`。
 * @param {(event: object) => object | null} [params.deriveMessage] - `session.deriveEventMessage`。
 * @returns {{text: string, seq: number} | null} 候选回话；取不到时 null。
 */
export function pickCandidate({ nodes, eventAt, deriveMessage }) {
  if (!Array.isArray(nodes)) return null;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const seq = nodes[i];
    let event;
    try {
      event = eventAt(seq);
    } catch {
      continue;
    }
    if (event === null || event === undefined) continue;
    if (event.type !== "assistant/message") continue;

    // 优先用 session 自己的派生（它管着内容块的重写/剔除），
    // 取不到再退回直接读事件的 payload 形状。
    let content = null;
    if (typeof deriveMessage === "function") {
      try {
        content = deriveMessage(event)?.content ?? null;
      } catch {
        content = null;
      }
    }
    if (content === null) content = event.payload?.message?.content ?? event.message?.content ?? null;

    const text = textOfBlocks(content);
    if (text.length > 0) return { text, seq };
  }
  return null;
}

/**
 * 取候选回话**之前**的近期记录摘要（给她自己复核时当上下文）。
 *
 * 为什么要上下文：supervisor 要判断的是「这句宣称有没有记录支撑」，没有记录
 * 就无从判断。这里只取**候选之前**的内容 —— 候选之后的都是结果，不该用来
 * 给她自己的话找理由。
 *
 * @param {object} params
 * @param {readonly number[]} params.nodes - `session.surface.nodes`。
 * @param {(seq: number) => object | undefined} params.eventAt - `session.eventAt`。
 * @param {number} [params.beforeSeq] - 候选所在的 seq，只取它之前的。
 * @param {number} [params.maxChars] - 摘要上限（字符）。
 * @param {number} [params.maxMessages] - 最多取几条。
 * @returns {string} 摘要文本；没有则空串。
 */
export function pickRecent({
  nodes,
  eventAt,
  deriveMessage,
  beforeSeq = Number.POSITIVE_INFINITY,
  maxChars = 2_000,
  maxMessages = 8,
} = {}) {
  if (!Array.isArray(nodes)) return "";
  const picked = [];
  for (let i = nodes.length - 1; i >= 0 && picked.length < maxMessages; i -= 1) {
    const seq = nodes[i];
    if (typeof beforeSeq === "number" && seq >= beforeSeq) continue;
    let event;
    try {
      event = eventAt(seq);
    } catch {
      continue;
    }
    if (event === null || event === undefined) continue;
    const type = event.type;
    if (type !== "user/message" && type !== "assistant/message") continue;

    let content = null;
    if (typeof deriveMessage === "function") {
      try {
        content = deriveMessage(event)?.content ?? null;
      } catch {
        content = null;
      }
    }
    if (content === null) content = event.payload?.message?.content ?? event.message?.content ?? null;
    const text = textOfBlocks(content);
    if (text.length === 0) continue;
    const who = type === "user/message" ? "开拓者" : "黑塔";
    picked.unshift(`${who}：${text}`);
  }
  const joined = picked.join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}
