/**
 * 映射逻辑的测试（`src/shared/mapping.js`）。
 *
 * 这一块之前埋在客户端里、**只能靠浏览器验证**；抽成纯函数后可以在 Node 里
 * 直接跑，覆盖那些浏览器里很难构造的情况（11 种节点各来一份）。
 *
 * 用法：node scripts/test-mapping.mjs
 */
import { fullSnapshot, isoOf, nodesToRecord, textOf, toBubbles } from "../src/shared/mapping.js";

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail === "" ? "" : `  —— ${detail}`}`);
  }
};

const AT = 1_789_000_000_000;

console.log("=== 取文本 ===");
ok(textOf([{ type: "text", text: "甲" }, { type: "text", text: "乙" }]) === "甲\n乙", "多个文本块用换行连接");
ok(textOf([{ type: "image", attachment: {} }]) === "", "纯图片块取不到文本");
ok(textOf(undefined) === "" && textOf(null) === "", "非数组安全返回空串");
ok(textOf([{ type: "text" }, { type: "text", text: 5 }]) === "", "缺 text 或 text 非字符串都被跳过");

console.log("\n=== 时间戳 ===");
ok(isoOf(AT)?.startsWith("2026-") === true, "数字 → ISO", String(isoOf(AT)));
ok(isoOf(undefined) === undefined && isoOf("x") === undefined, "非数字 → undefined（她的气泡会隐藏时间而不是伪造）");

console.log("\n=== 乙：节点 → 气泡 ===");
{
  const r = toBubbles([
    { kind: "user", seq: 1, time: AT, content: [{ type: "text", text: "你好" }] },
    { kind: "steering", seq: 2, time: AT, content: [{ type: "text", text: "插一句" }] },
    {
      kind: "assistant",
      seq: 3,
      time: AT,
      blocks: [
        { kind: "reasoning", text: "想一想" },
        { kind: "text", text: "她说的话" },
      ],
    },
    { kind: "assistant", seq: 4, time: AT, blocks: [{ kind: "reasoning", text: "只有思考" }] },
    { kind: "application", seq: 5, time: AT },
  ]);
  ok(r.bubbles.length === 3, "user / steering / assistant 各出一个气泡", `实际 ${r.bubbles.length}`);
  ok(r.bubbles[0].role === "user" && r.bubbles[2].role === "herta", "角色正确");
  ok(r.bubbles[2].text === "她说的话", "只取 text 块，丢掉 reasoning", r.bubbles[2].text);
  ok(r.dropped.total === 2, "只有 reasoning 的那条与未知节点计入 dropped", String(r.dropped.total));
  ok(r.dropped.kinds.includes("application"), "未知节点如实记下 kind");
  ok(typeof r.bubbles[0].at === "string", "带上 ISO 时间");
  ok(r.voiceCues.length === 0, "没有发声工具结果时不产出 cue");
}

console.log("\n=== 乙：herta_speak 的 cue 抽取 ===");
{
  const r = toBubbles([
    {
      kind: "tool-result",
      seq: 42,
      time: AT,
      call: { name: "herta_speak" },
      meta: { hertaVoice: { url: "/herta-voice/particle/%E5%97%AF/01.opus", clip: "particle/嗯/01.opus", category: "particle" } },
    },
    { kind: "tool-result", seq: 43, time: AT, call: { name: "read" }, meta: {} },
    { kind: "tool-result", seq: 44, time: AT, call: { name: "herta_speak" } },
  ]);
  ok(r.voiceCues.length === 1, "只有带 hertaVoice 的工具结果产出 cue", String(r.voiceCues.length));
  ok(r.voiceCues[0].seq === 42, "cue 记下 seq（客户端按它去重）");
  ok(r.voiceCues[0].url.includes("/herta-voice/"), "cue 带上可直接播放的 URL");
  ok(r.dropped.total === 3, "工具结果仍如实计入 dropped（它们不成气泡）", String(r.dropped.total));
}

console.log("\n=== 甲：节点 → 她的 TerminalRecord ===");
{
  const record = nodesToRecord([
    { kind: "user", seq: 1, time: AT, content: [{ type: "text", text: "你好" }] },
    { kind: "assistant", seq: 2, time: AT, blocks: [{ kind: "reasoning", text: "想" }, { kind: "text", text: "答复" }] },
    { kind: "tool-result", seq: 3, time: AT, call: { name: "read" }, isError: false },
    { kind: "tool-result", seq: 4, time: AT, call: { name: "pwsh" }, isError: true },
    { kind: "turn-error", seq: 5, time: AT, message: "没有 API Key" },
    { kind: "compaction", seq: 6, time: AT },
    { kind: "context", seq: 7, time: AT },
    { kind: "command", seq: 8, time: AT },
  ]);
  const kinds = record.map((b) => b.kind).join(",");
  ok(kinds === "user,herta,system,system,system,system", "块序列正确", kinds);
  ok(record[1].surface === "speech", "助手正文是 speech surface");
  ok(!JSON.stringify(record).includes("想"), "reasoning 没有进记录");
  ok(record[2].body === "read 已返回" && record[3].body === "pwsh 失败", "工具成功/失败措辞不同");
  ok(record[4].body === "没有 API Key", "turn-error 的原话进了 system 块");
  ok(record[0].label === undefined, "user 块没有 label 字段");
  ok(record[2].label === "系统", "system 块的 label 是「系统」");
  ok(nodesToRecord([{ kind: "context" }]).length === 0, "只有 context 时记录为空");
}

console.log("\n=== 甲：思考围栏必须被剥掉（2026-09-19 用户报的真 bug）===");
{
  // 她按原版语法把内心话写在 （我 想） 里、发言写在 （我 说） 里。
  // 不剥的话整段思考会被当成她的发言发到整机页面上 —— 实际发生过。
  const withFences = [
    { kind: "user", text: "你好" },
    {
      kind: "assistant",
      blocks: [
        {
          kind: "text",
          text: "（我 想）我不能把编的细节说成真的。（/我 想）（我 说）我说错了。（/我 说）",
        },
      ],
    },
  ];
  const rec = nodesToRecord(withFences);
  const herta = rec.filter((b) => b.kind === "herta");
  ok(herta.length === 1, "还是只有一条她的块");
  ok(herta[0].text === "我说错了。", "只保留说话部分", JSON.stringify(herta[0].text));
  ok(!herta[0].text.includes("（我 想）"), "思考围栏没有进记录");
  ok(!herta[0].text.includes("不能把编的细节"), "**思考内容没有被当成发言**");
  ok(herta[0].surface === "speech", "标记为 speech 表面");

  // 只有思考、没有说话 → 不该出现在记录里，但要对得上账
  const onlyThought = nodesToRecord([
    { kind: "assistant", blocks: [{ kind: "text", text: "（我 想）只想不说。（/我 想）" }] },
  ]);
  ok(onlyThought.length === 0, "只有思考的节点不进记录（不能当发言）");
}
{
  // 乙方案（toBubbles）同样要剥
  const r = toBubbles([
    {
      kind: "assistant",
      seq: 1,
      time: AT,
      blocks: [{ kind: "text", text: "（我 想）内心话（/我 想）（我 说）说出口的。（/我 说）" }],
    },
  ]);
  ok(r.bubbles.length === 1, "乙：一条气泡");
  ok(r.bubbles[0].text === "说出口的。", "乙：只保留说话部分", JSON.stringify(r.bubbles[0].text));
  ok(!r.bubbles[0].text.includes("内心话"), "乙：思考内容没有进气泡");
}
{
  // 她没写围栏时（早期对话 / 没按语法来）→ 整段当说话，不吞内容
  const rec = nodesToRecord([
    { kind: "assistant", blocks: [{ kind: "text", text: "没写围栏的一句话。" }] },
  ]);
  ok(rec.length === 1 && rec[0].text === "没写围栏的一句话。", "没有围栏时整段都是说话（不吞内容）");
}

console.log("\n=== 甲：SessionSnapshot ===");
{
  const s = fullSnapshot("session-abc", [{ kind: "user", text: "x" }]);
  ok(s.sessionId === "session-abc", "sessionId 透传");
  ok(typeof s.workspaceRoot === "string" && s.workspaceRoot !== "", "workspaceRoot 非空（空串时她的界面不渲染正文）");
  ok(s.overlay === null, "overlay 是 null（不是 {kind:'idle'}）");
  ok(!("recordStart" in s), "不给 recordStart（她的 store 自己按窗口算）");
  ok(s.lang === "zh" && s.backendWorkspaceIsDefault === true, "语言与工作区标记正确");

  const empty = fullSnapshot(undefined, []);
  ok(empty.sessionId === "" && empty.workspaceRoot.includes("current"), "sessionId 缺失时仍有非空 workspaceRoot");
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
