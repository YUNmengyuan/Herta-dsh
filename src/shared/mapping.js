/**
 * DSH 会话节点 ↔ Herta 记录块的映射。**两条方向，一个地方。**
 *
 * 抽出来的理由：这是客户端里逻辑最密的一段（11 种节点 → 3 种块，外加发声 cue），
 * 之前它埋在 `src/client/index.tsx` 里，**只能靠浏览器验证、无法单测**。
 * 现在是纯函数，Node 里可以直接跑（见 `scripts/test-mapping.mjs`）。
 *
 * 为什么用 `.js` 而不是 `.ts`：这样 Node 能直接 import 它做测试，esbuild 也能
 * 原样打包进 client bundle —— 一份代码，两个消费者，不需要额外的构建步骤。
 */

// ── 共同的小工具 ────────────────────────────────────────────────────────────

/**
 * 从 DSH 的 `ContentBlock[]` 里取纯文本。
 * 图片 / 文件 / 工具块这一版不处理（它们不是「她说的内容」）。
 * @param content - DSH 的内容块数组。
 * @returns 拼接后的纯文本；没有文本块时为空串。
 */
export function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        b.type === "text" &&
        typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/**
 * epoch ms → ISO。她的 `at` 要 ISO 字符串；拿不到就不给这个字段
 * （她的气泡会隐藏时间，而不是伪造一个「现在」）。
 * @param time - DSH 节点的 `time`。
 * @returns ISO 字符串或 undefined。
 */
export function isoOf(time) {
  return typeof time === "number" && Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** 把 `at` 折成可选字段，避免给她的块塞 `at: undefined`。 */
function stampOf(time) {
  const at = isoOf(time);
  return at === undefined ? {} : { at };
}

// ── 乙：DSH 节点 → 气泡（她的展示组件要的形态）────────────────────────────

/**
 * 降维成气泡列表。
 *
 * DSH 有 11 种会话节点，Herta 的展示组件只认 user / herta 两种气泡；
 * 其余（工具、上下文注入、命令、压缩、插曲、重试、错误）在她的模型里没有
 * 对应物，这里**如实计数并跳过**，而不是硬塞进 system 块假装有内容。
 *
 * @param nodes - DSH 的 `ConversationNode[]`。
 * @returns `{ bubbles, dropped, voiceCues }`。
 */
export function toBubbles(nodes) {
  const bubbles = [];
  const droppedKinds = [];
  const voiceCues = [];

  for (const raw of nodes) {
    const node = raw ?? {};
    if (node.kind === "user" || node.kind === "steering") {
      const text = textOf(node.content);
      if (text !== "") bubbles.push({ role: "user", text, ...stampOf(node.time) });
      continue;
    }
    if (node.kind === "assistant") {
      const text = (node.blocks ?? [])
        .filter((b) => b.kind === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // reasoning 块对应她的 thought surface，而她本来就不渲染 thought。
      if (text !== "") {
        bubbles.push({ role: "herta", text, ...stampOf(node.time) });
      } else {
        // 只有思考、没有正文的助手节点也**如实计入降维损失** ——
        // 与工具结果同一标准，否则这个计数器就只是在挑好说的记。
        droppedKinds.push("assistant:reasoning-only");
      }
      continue;
    }
    if (node.kind === "tool-result") {
      // `herta_speak` 的私有负载在 meta 上 —— 这是宿主与浏览器之间唯一的通道，
      // 不需要为它新开事件类型。
      const voice = node.meta?.hertaVoice;
      if (typeof voice?.url === "string" && typeof node.seq === "number") {
        voiceCues.push({
          seq: node.seq,
          url: voice.url,
          clip: voice.clip ?? "",
          category: voice.category ?? "",
        });
      }
      droppedKinds.push("tool-result");
      continue;
    }
    droppedKinds.push(String(node.kind ?? "unknown"));
  }

  return {
    bubbles,
    dropped: { total: droppedKinds.length, kinds: droppedKinds },
    voiceCues,
  };
}

// ── 甲：DSH 节点 → 她的 TerminalRecord（整机要的形态）──────────────────────

/**
 * 映射成她的 `TerminalRecord`。
 *
 * 与 `toBubbles` 是同一件事的反方向，规则保持一致：
 *
 * | DSH 节点 | 她的块 |
 * |---|---|
 * | `user` / `steering` | `user` |
 * | `assistant` 的 text 块 | `herta{surface:'speech'}` |
 * | `assistant` 的 reasoning 块 | **丢弃**（她的 `thought` surface 不渲染） |
 * | `tool-result` | `system{label:'系统'}`（她看的是终端记录，不是工具卡片） |
 * | `turn-error` | `system{label:'系统'}` |
 * | `compaction` | `system` 标记一句 |
 * | context / command / model-retry / unknown | 丢弃 |
 *
 * @param nodes - DSH 的 `ConversationNode[]`。
 * @returns 她的记录块数组。
 */
export function nodesToRecord(nodes) {
  const record = [];
  for (const raw of nodes) {
    const node = raw ?? {};
    const stamp = stampOf(node.time);

    if (node.kind === "user" || node.kind === "steering") {
      const text = textOf(node.content);
      if (text !== "") record.push({ kind: "user", text, ...stamp });
      continue;
    }
    if (node.kind === "assistant") {
      const text = (node.blocks ?? [])
        .filter((b) => b.kind === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (text !== "") record.push({ kind: "herta", surface: "speech", text, ...stamp });
      continue;
    }
    if (node.kind === "tool-result") {
      const name = node.call?.name ?? "工具";
      const body = node.isError === true ? `${name} 失败` : `${name} 已返回`;
      record.push({ kind: "system", label: "系统", body, ...stamp });
      continue;
    }
    if (node.kind === "turn-error") {
      const body = typeof node.message === "string" && node.message !== "" ? node.message : "本轮失败";
      record.push({ kind: "system", label: "系统", body, ...stamp });
      continue;
    }
    if (node.kind === "compaction") {
      record.push({ kind: "system", label: "系统", body: "（此处发生过一次上下文压缩）", ...stamp });
    }
  }
  return record;
}

/**
 * 造一份她的 `SessionSnapshot`。
 *
 * 字段**严格对照官网 demo 的 `snapshot()`**（那是已被证明能跑的构造）：
 *   · `overlay: null`（不是 `{kind:'idle'}` —— 空闲态她用的是 null）
 *   · 不给 `recordStart`（她的 store 自己按窗口算）
 *   · `workspaceRoot` 必须**非空**：空串时她的界面不渲染会话正文
 *
 * 用整体 reset 而不是增量 `record` 块：她的 store 本来就支持 replace 路径，
 * 而我们的数据源（组装好的节点数组）本身就是整份的。
 *
 * @param sessionId - DSH 会话 id。
 * @param record - `nodesToRecord` 的产物。
 * @returns 她的会话快照。
 */
export function fullSnapshot(sessionId, record) {
  const id = typeof sessionId === "string" ? sessionId : "";
  return {
    sessionId: id,
    workspaceRoot: `dsh://session/${id === "" ? "current" : id}`,
    record,
    overlay: null,
    title: null,
    lang: "zh",
    backendWorkspace: "~/.herta/workspaces/dsh",
    backendWorkspaceIsDefault: true,
  };
}
