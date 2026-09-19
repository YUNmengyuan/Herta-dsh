/**
 * 分拍策略的测试（`src/host/beat-policy.js`）。
 *
 * 这块判错的后果很直接：**每误判一次就多一个 step、多一次 LLM 调用**。
 * 一次 turn 里有十几个工具调用，判宽了会把她的回复碎成一地、成本翻几倍；
 * 判严了她又该说的时候不说话。所以每条判据都钉住。
 *
 * 用法：node scripts/test-beat-policy.mjs
 */
import {
  BeatBudget,
  MAX_BEATS_PER_TURN,
  buildBeatSteering,
  decideBeat,
  failureSummary,
  looksLikeVerification,
} from "../src/host/beat-policy.js";
import {
  BEAT_HINT_TOOL_FAIL,
  BEAT_HINT_VERIFICATION_FINISHED,
  FORCED_SPEECH_OPEN_TAG,
  STOP_SPEECH_CLOSE,
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

const okExec = (name = "read") => ({ name });
const failResult = (msg = "boom") => ({ isError: true, error: { message: msg } });
const okResult = () => ({ isError: false, value: 1 });

console.log("=== looksLikeVerification ===");
for (const n of ["run_tests", "test-mapping.mjs", "npm_lint", "typecheck", "cargo_build", "vet"]) {
  ok(looksLikeVerification(n) === true, `「${n}」判为验证类`);
}
for (const n of ["read", "write", "glob", "grep", "web_search", "herta_memory_save"]) {
  ok(looksLikeVerification(n) === false, `「${n}」判为非验证类`);
}
ok(looksLikeVerification("") === false, "空名字 → false");
ok(looksLikeVerification(undefined) === false, "undefined → false");
ok(looksLikeVerification("TEST") === true, "大小写不敏感");

console.log("\n=== decideBeat：失败一律值得一句 ===");
{
  const r = decideBeat(okExec("pwsh"), failResult());
  ok(r?.kind === "tool-failed", "普通工具失败 → tool-failed", JSON.stringify(r));
  ok(r?.beat === BEAT_HINT_TOOL_FAIL, "用上游的 tool.fail 提示");
}
ok(decideBeat(okExec("run_tests"), failResult())?.kind === "verification-failed", "验证类失败 → verification-failed");
ok(
  decideBeat(okExec("run_tests"), failResult())?.beat === BEAT_HINT_TOOL_FAIL,
  "验证失败也用同一条提示（上游只有这一条讲失败）",
);

console.log("\n=== decideBeat：成功只有验证类才值得说 ===");
{
  const r = decideBeat(okExec("run_tests"), okResult());
  ok(r?.kind === "verification-passed", "验证类成功 → verification-passed", JSON.stringify(r));
  ok(r?.beat === BEAT_HINT_VERIFICATION_FINISHED, "用上游的 verification 提示");
}
for (const n of ["read", "write", "glob", "edit"]) {
  ok(decideBeat(okExec(n), okResult()) === null, `「${n}」成功 → 不点评（是常态，点评变噪音）`);
}

console.log("\n=== decideBeat：边界 ===");
ok(decideBeat(okExec(""), failResult()) === null, "工具名为空 → null");
ok(decideBeat({}, failResult()) === null, "没有 name → null");
ok(decideBeat(okExec("read"), null) === null, "result 为 null → null（走成功分支，非验证类）");
ok(decideBeat(okExec("run_tests"), null)?.kind === "verification-passed", "result 为 null 但验证类 → 仍算成功");
ok(decideBeat(okExec("read"), undefined) === null, "result 为 undefined → null");
ok(decideBeat(okExec("read"), {}) === null, "result 没有 isError → 按成功处理");
ok(
  decideBeat(okExec("read"), { isError: "true" }) === null,
  "isError 是字符串（非布尔）→ 不误判为失败",
);

console.log("\n=== failureSummary ===");
ok(failureSummary({ error: "直接的字符串错误" }) === "直接的字符串错误", "error 是字符串");
ok(failureSummary(failResult("来自 message")) === "来自 message", "error.message");
ok(failureSummary({ error: { reason: "来自 reason" } }) === "来自 reason", "error.reason");
ok(failureSummary({ error: { code: "E_BOOM" } }) === "E_BOOM", "error.code");
ok(
  failureSummary({ error: { message: "msg 优先", reason: "reason 在后" } }) === "msg 优先",
  "多个字段时 message 优先",
);
ok(
  failureSummary({ content: [{ type: "text", text: "内容块兜底" }] }) === "内容块兜底",
  "没有 error 时用 content 文本块",
);
ok(failureSummary({}) === "", "什么都没有 → 空串");
ok(failureSummary(null) === "", "null 安全");
ok(failureSummary(undefined) === "", "undefined 安全");
ok(failureSummary({ error: "x".repeat(600) }).length === 401, "长错误被截断并加省略号", String(failureSummary({ error: "x".repeat(600) }).length));
ok(failureSummary({ error: "短" }) === "短", "短错误不截断");
ok(failureSummary({ error: { message: "  留白  " } }) === "留白", "trim");

console.log("\n=== BeatBudget：一个 turn 的 beat 配额 ===");
{
  const b = new BeatBudget();
  ok(b.canBeat(1) === true, "新 turn 可以补拍");
  b.record(1);
  ok(b.canBeat(1) === (MAX_BEATS_PER_TURN > 1), "用掉 1 次后的可否决性与上限一致");
  while (b.canBeat(1)) b.record(1);
  ok(b.canBeat(1) === false, "配额耗尽 → 不再补拍（防 LLM 调用爆炸）");
  ok(b.canBeat(2) === true, "另一个 turn 有独立配额");
  ok(b.canBeat(NaN) === false, "turn 号非数字 → 保守拒绝");
}
{
  const b = new BeatBudget(2, 3);
  b.record(1); b.record(2); b.record(3); b.record(4);
  ok(b.used.size === 3, "只保留最近 keepTurns 个 turn 的账", String(b.used.size));
  ok(b.used.has(1) === false && b.used.has(4) === true, "淘汰最旧的");
}
ok(new BeatBudget(5).max === 5, "上限可构造覆盖");
ok(MAX_BEATS_PER_TURN >= 1 && MAX_BEATS_PER_TURN <= 5, "默认上限是合理的小数字", String(MAX_BEATS_PER_TURN));

console.log("\n=== buildBeatSteering ===");
{
  const s = buildBeatSteering({ kind: "tool-failed", beat: BEAT_HINT_TOOL_FAIL }, "命令返回 1");
  ok(s.startsWith("【记录"), "包了记录口吻的外壳（steer 注入的是 user 消息）");
  ok(s.includes("命令返回 1"), "摘要进入文本");
  ok(s.includes(BEAT_HINT_TOOL_FAIL), "上游提示原文进入文本");
  ok(s.includes(FORCED_SPEECH_OPEN_TAG) && s.includes(STOP_SPEECH_CLOSE), "提示本身要求说话围栏");
}
{
  const s = buildBeatSteering({ kind: "verification-passed", beat: BEAT_HINT_VERIFICATION_FINISHED }, "");
  ok(s.includes("验证"), "验证类用「验证」措辞");
  ok(!s.includes("这一步的结果："), "没有摘要时不写摘要行");
}
{
  const s = buildBeatSteering({ kind: "verification-failed", beat: BEAT_HINT_TOOL_FAIL }, "3 failed");
  ok(s.includes("验证失败了"), "验证失败用「验证失败」措辞");
}
{
  const s = buildBeatSteering({ kind: "tool-failed", beat: BEAT_HINT_TOOL_FAIL }, "");
  ok(s.includes("工具调用失败"), "普通失败用工具调用措辞");
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
