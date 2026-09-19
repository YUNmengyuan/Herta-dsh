/**
 * supervisor 复核的纯逻辑测试（`src/host/supervisor.js`）。
 *
 * 为什么这些必须测：supervisor 的判决直接决定**要不要打断她的回复**。
 * 解析错了有两种坏法，都很难在浏览器里看出根因：
 *   · 把该放行的判成否决 → 她的正常回复被扣住重说（现象是「她老在重复」）
 *   · 把该否决的判成放行 → 谎话照发（这是复核存在的理由）
 * 所以判决解析的每条退化路径都钉住。
 *
 * LLM 调用本身不在这里 —— 见 `src/host/supervisor-llm.js`，本机没有 API Key，
 * 那条路径无法验证，刻意隔离出去。
 *
 * 用法：node scripts/test-supervisor.mjs
 */
import {
  FALLBACK_VETO_REASON,
  MAX_VETOES_PER_TURN,
  VERDICT_PASS,
  VERDICT_VETO,
  buildSupervisorSystemPrompt,
  buildSupervisorUserPrompt,
  buildVetoSteering,
  extractFirstJsonObject,
  normalizeDecision,
  parseSupervisorVerdict,
} from "../src/host/supervisor.js";
import {
  FORCED_SPEECH_OPEN_TAG,
  STOP_SPEECH_CLOSE,
  SUPERVISOR_RESPEAK,
  THOUGHT_OPEN_TAG,
} from "../src/host/narrative-hints.js";

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

console.log("=== extractFirstJsonObject ===");
ok(extractFirstJsonObject('{"verdict":"pass"}')?.verdict === "pass", "裸 JSON 对象");
ok(
  extractFirstJsonObject('前置解释文字 {"verdict":"veto","reason":"x"} 后置文字')?.verdict === "veto",
  "JSON 前后有解释文字",
);
ok(
  extractFirstJsonObject('```json\n{"verdict":"pass"}\n```')?.verdict === "pass",
  "```json 围栏内",
);
ok(
  extractFirstJsonObject('{"verdict":"veto","reason":"他说的 {花括号} 是错的"}')?.reason === "他说的 {花括号} 是错的",
  "reason 里含花括号不破坏平衡扫描",
);
ok(
  extractFirstJsonObject('{"a":{"b":{"c":1}},"verdict":"pass"}')?.verdict === "pass",
  "嵌套对象",
);
ok(
  extractFirstJsonObject('{"reason":"引号 \\" 被转义","verdict":"pass"}')?.verdict === "pass",
  "字符串里的转义引号",
);
ok(extractFirstJsonObject("没有 JSON，只有一句话") === null, "无 JSON → null");
ok(extractFirstJsonObject("{不是合法 JSON}") === null, "括号不平衡/非法 JSON → null");
ok(extractFirstJsonObject("[1,2,3]") === null, "数组不算（只要对象）");
ok(extractFirstJsonObject("") === null, "空串 → null");

console.log("\n=== parseSupervisorVerdict：结构化 ===");
ok(parseSupervisorVerdict('{"verdict":"pass"}')?.verdict === VERDICT_PASS, 'verdict:"pass"');
{
  const r = parseSupervisorVerdict('{"verdict":"veto","reason":"她声称写了文件但没调用工具"}');
  ok(r?.verdict === VERDICT_VETO, 'verdict:"veto"');
  ok(r?.reason === "她声称写了文件但没调用工具", "因由被取到", r?.reason);
}
ok(parseSupervisorVerdict('{"decision":"veto","reason":"x"}')?.verdict === VERDICT_VETO, "decision 字段别名");
ok(parseSupervisorVerdict('{"result":"pass"}')?.verdict === VERDICT_PASS, "result 字段别名");
ok(parseSupervisorVerdict('{"verdict":true}')?.verdict === VERDICT_PASS, "布尔 true → pass");
ok(parseSupervisorVerdict('{"verdict":false}')?.verdict === VERDICT_VETO, "布尔 false → veto");
ok(
  parseSupervisorVerdict('{"verdict":"VETO","reason":"x"}')?.verdict === VERDICT_VETO,
  "大写判决词",
);
{
  // 无法识别的判决词 → 落到退化路径。这段文本里也没有「否决/驳回/通过」，
  // 所以最终应给 null（调用方保守放行），绝不能凭空判成 veto 去打断她。
  const r = parseSupervisorVerdict('{"verdict":"原因","reason":"x"}');
  ok(r === null, "无法识别的判决词不误判（落到退化路径后仍看不懂 → null）", JSON.stringify(r));
}

console.log("\n=== parseSupervisorVerdict：退化文本 ===");
{
  const r = parseSupervisorVerdict("VETO: 她记错了");
  ok(r?.verdict === VERDICT_VETO, "VETO: 因由");
  ok(r?.reason === "她记错了", "因由取到", r?.reason);
}
ok(parseSupervisorVerdict("veto")?.verdict === VERDICT_VETO, "光秃秃一个 veto");
ok(parseSupervisorVerdict("否决：她把打算说成做完了")?.verdict === VERDICT_VETO, "中文「否决：」");
ok(parseSupervisorVerdict("驳回")?.verdict === VERDICT_VETO, "中文「驳回」");
ok(parseSupervisorVerdict("PASS")?.verdict === VERDICT_PASS, "PASS");
ok(parseSupervisorVerdict("通过")?.verdict === VERDICT_PASS, "中文「通过」");
ok(parseSupervisorVerdict("这句话没问题，通过。")?.verdict === VERDICT_PASS, "含「通过」的句子");
ok(
  parseSupervisorVerdict("先说一句：这句有点问题，但整体 VETO 不成立")
    ?.verdict === VERDICT_VETO,
  "同时出现两个词时否决优先（保守）",
);

console.log("\n=== parseSupervisorVerdict：看不懂时必须放行 ===");
ok(parseSupervisorVerdict("嗯……我再看看") === null, "含糊输出 → null（调用方放行）");
ok(parseSupervisorVerdict("") === null, "空串 → null");
ok(parseSupervisorVerdict("   ") === null, "纯空白 → null");
ok(parseSupervisorVerdict(null) === null, "null → null");
ok(parseSupervisorVerdict(undefined) === null, "undefined → null");
ok(parseSupervisorVerdict(42) === null, "非字符串 → null");

console.log("\n=== normalizeDecision：否决必须带因由（防「白吃一次否决」）===");
ok(normalizeDecision({ verdict: VERDICT_VETO, reason: "  " }).reason === FALLBACK_VETO_REASON, "因由为空 → 兜底句");
ok(normalizeDecision({ verdict: VERDICT_VETO }).reason === FALLBACK_VETO_REASON, "缺因由 → 兜底句");
ok(normalizeDecision({ verdict: VERDICT_PASS, reason: "随便" }).reason === "", "放行时因由清空");
ok(normalizeDecision(null) === null, "null 安全");
{
  const r = parseSupervisorVerdict("VETO");
  ok(r?.reason === FALLBACK_VETO_REASON, "退化路径的否决也拿到兜底因由", r?.reason);
}
{
  const r = parseSupervisorVerdict('{"verdict":"veto"}');
  ok(r?.reason === FALLBACK_VETO_REASON, "结构化路径的否决也拿到兜底因由");
}

console.log("\n=== buildVetoSteering：两阶段注入 ===");
{
  const s = buildVetoSteering("她把没写入的说成写入了。");
  ok(typeof s.rethink === "string" && s.rethink.length > 0, "有 rethink");
  ok(typeof s.respeak === "string" && s.respeak.length > 0, "有 respeak");
  ok(s.selfCorrection === "她把没写入的说成写入了", "selfCorrection 去掉句末标点", s.selfCorrection);
  ok(s.rethink.includes("她把没写入的说成写入了"), "因由进入 rethink");
  ok(!s.rethink.includes("{{reason}}"), "rethink 里没有未替换的占位符");
  ok(s.rethink.includes(THOUGHT_OPEN_TAG), "rethink 要求先想（（我 想））");
  ok(s.respeak.includes(FORCED_SPEECH_OPEN_TAG), "respeak 要求后说（（我 说））");
  ok(s.respeak.includes(STOP_SPEECH_CLOSE), "respeak 带说话闭围栏");
  // 注入口吻：steer 只能注入 user 角色消息，所以必须包一层记录外壳
  ok(s.rethink.startsWith("【记录"), "rethink 包了记录口吻的外壳（steer 注入的是 user 消息）");
  ok(s.respeak.startsWith("【记录"), "respeak 同样包了外壳");
  ok(
    !s.rethink.startsWith("〔我刚才说的话被自己回头一看就否了"),
    "不是把她的第一人称内心话直接当 user 消息丢进去",
  );
  ok(s.respeak.includes(SUPERVISOR_RESPEAK.slice(0, 20)), "respeak 用的是上游模板原文");
}
{
  const s = buildVetoSteering("");
  ok(s.rethink.length > 0 && !s.rethink.includes("{{reason}}"), "空因由也不产出坏提示");
}

console.log("\n=== 提示构造 ===");
{
  const sys = buildSupervisorSystemPrompt();
  ok(sys.includes("JSON"), "system 要求 JSON 输出");
  ok(sys.includes("verdict"), "system 说明判决字段");
  ok(sys.includes("不要拦"), "system 明确列出不该拦的情况");
  ok(sys.includes("口吻"), "system 说明不管口吻（她的嘲讽不该被拦）");
}
{
  const u = buildSupervisorUserPrompt({ candidate: "我记下来了。", recent: "用户：记一下" });
  ok(u.includes("她的候选回话"), "user 提示带候选");
  ok(u.includes("我记下来了"), "候选原话进入提示");
  const parsed = JSON.parse(u.slice(u.indexOf("{")));
  ok(parsed["她的候选回话"] === "我记下来了。", "用 JSON 包裹，她的文本破坏不了结构");
}
{
  const u = buildSupervisorUserPrompt({ candidate: '含 "引号" 和 {花括号}' });
  const jsonText = u.slice(u.indexOf("{"));
  let parsedOk = true;
  try {
    JSON.parse(jsonText);
  } catch {
    parsedOk = false;
  }
  ok(parsedOk, "候选里含引号/花括号时 JSON 仍合法");
  ok(buildSupervisorUserPrompt({}).includes("（无）"), "没有近期记录时给占位");
}

console.log("\n=== 防死循环闸 ===");
ok(MAX_VETOES_PER_TURN >= 1 && MAX_VETOES_PER_TURN <= 5, "否决上限是一个合理的正数", String(MAX_VETOES_PER_TURN));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
