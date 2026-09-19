/**
 * 假模型服务（用于在**没有 API Key** 的环境里验证真实链路）。
 *
 * ## 为什么要有这个
 *
 * lab 与正式环境都没有模型凭据，而 `agent/turn-stopping` 又**只在 turn 正常
 * 结束**时才触发 —— 所以「supervisor 复核 → 否决 → 她重说」这条链在无 Key 的
 * lab 里永远走不到。集成测试（`test-llm-integration.mjs`）验的是**管道**，
 * 但绕过 HTTP 与适配器那两层。
 *
 * 这个服务补上那两层：DSH 会真的发 HTTP 请求、真的解析 SSE、真的走完
 * 「模型输出 → 工具 → turn 结束 → 复核 → steer → 她再说一轮」。
 *
 * ## 它不碰任何真实凭据
 *
 * DeepSeek provider 的配置里只放**凭据的名字**（`apiKeyEnv`），不放密钥
 * （`dsh-llm-deepseek` 的 `Config` 注释原话：「a literal key is not a
 * configuration value」）。所以 lab 指向这里时，用的是一个**假的环境变量名**，
 * 与用户真实的那份凭据毫无关系。
 *
 * ## 按第几次调用变化
 *
 * 这是关键：固定输出只能测「通过」分支，测不到否决。所以：
 *   · 第 1 次（她的正常回复）→ 先调一个工具，再给一句话
 *   · 第 2 次（复核）        → `veto` + 因由
 *   · 第 3 次（她重说）      → 一句修正过的话
 *   · 第 4 次及以后（复核）  → `pass`
 *
 * 这样一次会话就能看到：工具调用 → 分拍判据 → turn-stopping → 复核否决 →
 * `steer` → 她重说 → 复核放行 → turn 真的结束。
 *
 * 用法：node scripts/mock-llm-server.mjs [--port 8791]
 */
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8791;

/**
 * 第几次调用（从 1 开始）。
 *
 * 调用序列里**有第三方插入**，不能只靠计数认人：
 *   · `dsh-session-title-llm` 会在第一轮之后发一次会话标题调用（`max_tokens` 很小）
 *   · 复核（supervisor）与蒸馏也是不带工具的一次性调用
 * 所以阶段判定要看 **system 提示的词**，不看次数（实测踩过：把 veto JSON 当成了
 * 会话标题返回）。
 */
let callCount = 0;
/** 复核被调用了几次 —— 用来让第一次否决、之后放行。 */
let supervisorCalls = 0;
/** 是否已经发过第一次对话（那一次刻意发起一个失败的工具调用）。 */
let firstConversationSeen = false;
/** 供验证时读取的调用日志。 */
const calls = [];

/**
 * 造一个 OpenAI 兼容的 SSE 响应体。
 * @param {string} content - 要「说」的文本。
 * @param {string} [reasoning] - 可选的 reasoning 内容。
 * @param {Array<{id: string, name: string, args: string}>} [toolCalls] - 工具调用。
 */
function sseBody(content, reasoning, toolCalls) {
  const chunkOf = (delta, finish) => ({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });

  const parts = [];
  parts.push(`data: ${JSON.stringify(chunkOf({ role: "assistant", content: "" }))}\n\n`);
  if (typeof reasoning === "string" && reasoning.length > 0) {
    parts.push(`data: ${JSON.stringify(chunkOf({ reasoning_content: reasoning }))}\n\n`);
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    // 工具调用按 OpenAI 的形状：第一个 chunk 带 id/name，后续 chunk 带参数增量。
    const deltas = toolCalls.map((c, i) => ({
      index: i,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));
    parts.push(`data: ${JSON.stringify(chunkOf({ tool_calls: deltas }))}\n\n`);
    parts.push(`data: ${JSON.stringify(chunkOf({}, "tool_calls"))}\n\n`);
  } else {
    // 正文按小块发，模拟流式。
    for (const piece of String(content).match(/[\s\S]{1,16}/g) ?? []) {
      parts.push(`data: ${JSON.stringify(chunkOf({ content: piece }))}\n\n`);
    }
    parts.push(`data: ${JSON.stringify(chunkOf({}, "stop"))}\n\n`);
  }
  parts.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "deepseek-flash",
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })}\n\n`,
  );
  parts.push("data: [DONE]\n\n");
  return parts.join("");
}

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("mock-llm: only POST");
    return;
  }
  let raw = "";
  req.on("data", (d) => {
    raw += d;
  });
  req.on("end", () => {
    callCount += 1;
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 忽略 */
    }
    const toolsOffered = Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name ?? t?.name) : [];
    const systemText = (() => {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      return messages
        .filter((m) => m?.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
        .join("\n");
    })();

    // 阶段判定看 system 的词（不能只看「有没有工具」：会话标题调用也不带工具）。
    // 顺序有讲究：先认「复核」（它的 system 里有「自省复核器」），再认蒸馏。
    const stage = toolsOffered.length > 0
      ? "conversation"
      : /自省复核器/.test(systemText)
        ? "supervisor"
        : /值不值得|worthy/i.test(systemText)
          ? "distill-worthiness"
          : /废案|语气范本/.test(systemText)
            ? "distill-generation"
            : "other-auxiliary";

    calls.push({ n: callCount, stage, toolCount: toolsOffered.length, systemHead: systemText.slice(0, 40) });
    console.log(
      `[mock-llm] 第 ${callCount} 次 stage=${stage} tools=${toolsOffered.length} max_tokens=${body.max_tokens ?? "-"}`,
    );

    let payload;
    if (stage === "distill-worthiness") {
      // 蒸馏第一阶段：判值得记（走「值得」分支，好让第二阶段真的发生）。
      payload = sseBody('{"worthy":true}');
    } else if (stage === "distill-generation") {
      // 蒸馏第二阶段：给一份**能过门**的候选（≥120 字、围栏成对、标题新颖）。
      const body =
        "（我 说）你把那个报错贴上来我就看，别描述它。（/我 说）\n\n"
        + "（我 想）他习惯先讲一遍自己觉得哪里不对，再给原文；那一段描述通常比报错本身更误导人。"
        + "我先要原始输出，省得跟着他的猜测走一趟。（/我 想）\n\n"
        + "（我 说）猜测不用给我，你猜错的次数比猜对的多。原始输出。（/我 说）";
      payload = sseBody(JSON.stringify({ title: "他先讲猜测再给报错", body }));
    } else if (stage === "supervisor") {
      supervisorCalls += 1;
      // 第一次否决，之后放行 —— 这样能看到「否决 → steer → 她重说 → 放行 → turn 真的结束」。
      payload =
        supervisorCalls === 1
          ? sseBody('{"verdict":"veto","reason":"她宣称写过笔记，但记录里没有任何写入工具调用"}')
          : sseBody('{"verdict":"pass"}');
    } else if (stage === "conversation") {
      if (firstConversationSeen === false) {
        firstConversationSeen = true;
        // 第 1 次对话：**调用 herta_dream 走蒸馏**。
        // 蒸馏会触发两次辅助调用（worthiness → generation），生成候选后过
        // promoteFeian 的三道门，再落进做梦账本 —— 这条链此前完全没验过。
        payload = sseBody("", "这段值得记下来。", [
          {
            id: "call_mock_dream",
            name: "herta_dream",
            args: '{"distill":true}',
          },
        ]);
      } else {
        // 工具跑完之后她说话（第一轮刻意说一句没凭据的话，好让复核有东西可拦）。
        payload =
          supervisorCalls === 0
            ? sseBody("（我 说）行，我把那个改动写进你的笔记了。（/我 说）")
            : sseBody(
                "（我 想）复核说得对，盘上没有那回事，我刚才把打算说成了做完。（/我 想）\n\n"
                  + "（我 说）我说错了 —— 我没有写过，那只是我打算做的。（/我 说）",
                "复核指出我刚才那句话没有凭据。",
              );
      }
    } else {
      // 会话标题等第三方辅助调用：给一句**人话**，不要给 JSON。
      payload = sseBody("与黑塔的一次对话");
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.end(payload);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-llm] 假模型服务已就绪：http://127.0.0.1:${PORT}/chat/completions`);
  console.log("[mock-llm] 第 1 次=她说一句没凭据的话 / 第 2 次=复核(veto) / 第 3 次=她重说 / 之后=pass");
});
