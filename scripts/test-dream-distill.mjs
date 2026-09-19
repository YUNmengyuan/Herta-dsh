/**
 * 做梦蒸馏的纯逻辑测试（`src/host/dream-distill.js`）。
 *
 * 这块判错的后果是**她的记忆货架被污染**：蒸馏出的候选要是带着没闭合的围栏，
 * 或者根本不成形，轻则被门拒收（白花一次 LLM 调用），重则如果解析宽容过头、
 * 把半截 JSON 当正文写进去，一份坏记忆就会进她下一轮的系统提示词。
 *
 * 所以解析的每一条退化路径都钉住，且**明确验证解析是「拒收」而不是「猜」**。
 *
 * 用法：node scripts/test-dream-distill.mjs
 */
import {
  MIN_DISTILL_CHARS,
  buildGenerationPrompt,
  buildWorthinessPrompt,
  parseDistilled,
  parseJsonObject,
  parseWorthiness,
} from "../src/host/dream-distill.js";

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

const goodBody = `${"（我 说）行，放那儿吧。（/我 说）".repeat(1)}\n\n${"他问了个不值得回答的问题。"}${"嗯".repeat(120)}`;

console.log("=== parseJsonObject ===");
ok(parseJsonObject('{"a":1}')?.a === 1, "裸 JSON");
ok(parseJsonObject('```json\n{"a":1}\n```')?.a === 1, "剥 ```json 围栏");
ok(parseJsonObject('```\n{"a":1}\n```')?.a === 1, "剥裸 ``` 围栏");
ok(parseJsonObject('解释文字 {"a":1} 后置文字')?.a === 1, "前后有解释文字");
ok(parseJsonObject('{"t":"含 {花括号} 的值"}')?.t === "含 {花括号} 的值", "值里含花括号不破坏平衡扫描");
ok(parseJsonObject('{"t":"引号 \\" 转义"}')?.t === '引号 " 转义', "值里含转义引号");
ok(parseJsonObject('{"a":{"b":1}}')?.a?.b === 1, "嵌套对象");
ok(parseJsonObject("[1,2]") === null, "数组不算");
ok(parseJsonObject("没有 JSON") === null, "无 JSON");
ok(parseJsonObject("{不合法}") === null, "非法 JSON");
ok(parseJsonObject("") === null && parseJsonObject(null) === null && parseJsonObject(42) === null, "空/非字符串安全");

console.log("\n=== parseWorthiness ===");
ok(parseWorthiness('{"worthy":true}')?.worthy === true, 'worthy:true');
{
  const r = parseWorthiness('{"worthy":false,"reason":"全程事务性，没有她的判断"}');
  ok(r?.worthy === false, "worthy:false");
  ok(r?.reason === "全程事务性，没有她的判断", "原因被取到", r?.reason);
}
ok(parseWorthiness('{"worth":true}')?.worthy === true, "worth 字段别名");
ok(parseWorthiness('{"value":true}')?.worthy === true, "value 字段别名");
ok(parseWorthiness('{"worthy":"TRUE"}')?.worthy === true, "字符串 true");
ok(parseWorthiness('{"worthy":"值得"}')?.worthy === true, "中文字符串「值得」");
ok(parseWorthiness('{"worthy":"no","reason":"x"}')?.worthy === false, "字符串 no");
ok(parseWorthiness('{"worthy":"看不懂"}') === null, "无法识别的取值 → null（跳过，不硬造记忆）");
ok(parseWorthiness("不是 JSON") === null, "不是 JSON → null");
ok(parseWorthiness(null) === null, "null → null");
ok(parseWorthiness('{"worthy":false}')?.reason === "", "拒收但没给原因时 reason 为空串");

console.log("\n=== parseDistilled：合格候选 ===");
{
  const r = parseDistilled(JSON.stringify({ title: "一条不需要回复的消息", body: goodBody }));
  ok(r.title === "一条不需要回复的消息", "标题解析");
  ok(r.body.length >= MIN_DISTILL_CHARS, "正文解析");
  ok(r.error === undefined, "没有 error");
}
{
  // 字段别名
  const r = parseDistilled(JSON.stringify({ name: "T", text: goodBody }));
  ok(r.title === "T" && r.body.length > 0, "name/text 别名可用");
}
{
  // body 误带 ### 废案_ 头 → 剥掉而不是拒收
  const withHead = `### 废案_07：误带的头\n\n${goodBody}`;
  const r = parseDistilled(JSON.stringify({ title: "T", body: withHead }));
  ok(r.error === undefined, "误带废案头仍可用");
  ok(!r.body.includes("### 废案_07"), "废案头被剥掉（头部由 promoteFeian 组装）");
  ok(r.body.includes("（我 说）"), "正文其余内容保留");
}

console.log("\n=== parseDistilled：必须拒收的 ===");
ok(parseDistilled(JSON.stringify({ body: goodBody }))?.error === "候选没有标题", "缺标题 → 拒收");
ok(parseDistilled(JSON.stringify({ title: "T" }))?.error === "候选没有正文", "缺正文 → 拒收");
ok(parseDistilled(JSON.stringify({ title: "T", body: "太短" }))?.error?.includes("太短") === true, "正文过短 → 拒收");
ok(parseDistilled(JSON.stringify({ title: "  ", body: goodBody }))?.error === "候选没有标题", "标题只有空白 → 拒收");
{
  const r = parseDistilled("这不是 JSON");
  ok(r.error === "模型没有产出可解析的 JSON", "非 JSON → 拒收（不猜、不硬写）");
}
ok(parseDistilled(null)?.error !== undefined, "null → 拒收");
{
  // 剥掉头部后过短
  const r = parseDistilled(JSON.stringify({ title: "T", body: `### 废案_07：头\n\n短` }));
  ok(r.error !== undefined, "剥头后过短 → 拒收");
}
// 关键：绝不返回半截内容当正文
{
  const r = parseDistilled('{"title":"T","body":"未闭合的 JSON 字符串');
  ok(r.error !== undefined, "JSON 截断 → 拒收而不是把半截当正文");
}

console.log("\n=== buildWorthinessPrompt ===");
{
  const p = buildWorthinessPrompt({ excerpt: "开拓者：帮我看下这个报错" });
  ok(p.includes("值得"), "含判定框架");
  ok(p.includes("worthy"), "要求 worthy 字段");
  ok(p.includes("开拓者：帮我看下这个报错"), "片段进入提示");
  ok(p.includes("（我 想）"), "提到自我观察这条信号");
  ok(p.includes("（货架上还没有废案）"), "没有已有标题时给占位");
  ok(!p.includes("板砖"), "不含上游那套差分协处理器场景（DSH 里没有）");
}
{
  const p = buildWorthinessPrompt({ excerpt: "x", existingTitles: ["他问了个不值得回答的问题"] });
  ok(p.includes("他问了个不值得回答的问题"), "已有标题进入提示（供去重）");
}

console.log("\n=== buildGenerationPrompt ===");
{
  const p = buildGenerationPrompt({ excerpt: "开拓者：你记一下" });
  ok(p.includes("### 废案_"), "说明正文不要自己写废案头");
  ok(p.includes("（我 说）") && p.includes("（/我 说）"), "含说话围栏的成对要求");
  ok(p.includes("（我 想）") && p.includes("（/我 想）"), "含思考围栏的成对要求");
  ok(p.includes("闭合"), "强调围栏必须闭合（门会拒收不闭合的）");
  ok(p.includes("不得嵌套"), "强调不得嵌套");
  ok(p.includes(String(MIN_DISTILL_CHARS)), "把篇幅下限写进提示（与门一致）");
  ok(p.includes("title") && p.includes("body"), "要求 title/body 字段");
  ok(p.includes("开拓者：你记一下"), "片段进入提示");
}
{
  const p = buildGenerationPrompt({ excerpt: "x", existingTitles: ["甲", "乙"] });
  ok(p.includes("甲") && p.includes("乙"), "已有标题进入提示（要求取不同的）");
}
{
  const p = buildGenerationPrompt({});
  ok(p.length > 0 && !p.includes("undefined"), "缺 excerpt 时不产出坏提示");
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
