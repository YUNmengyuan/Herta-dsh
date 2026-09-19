/**
 * 叙述层 LLM 路径的**集成测试**（用 mock 的 `ctx.llm` 服务）。
 *
 * ## 这个测试填的是哪块空白
 *
 * lab 与正式环境**都没有 API Key**，所以 supervisor 复核与做梦蒸馏的真实闭环
 * 无法端到端验证。但「真实模型」与「管道正确」是两件事：
 *
 *   · 管道：组装请求 → 消费流 → `BlockAssembler` → 解析 → 决策/落门
 *   · 真实模型：它到底回什么
 *
 * 这个测试用 mock 服务把**管道**整条跑通 —— 那正是最容易写错的部分
 * （`assembler.push` 收到什么、`finish.kind` 怎么判、解析失败怎么降级）。
 * 真实模型的行为仍然没验，但那已经不属于「代码正确性」了。
 *
 * ## 必须先读 `scripts/test-resolve-hook.mjs`
 *
 * 本仓库不带 `node_modules`，而这两个模块静态 import `@deepseek-ai/dsh-llm`，
 * 所以要靠 resolve hook 指向本机 DSH 运行时。运行方式：
 *
 * ```powershell
 * $hook = ([System.Uri]::new('E:\deepseek工作区\dsh-herta\scripts\test-resolve-hook.mjs')).AbsoluteUri
 * node --import $hook scripts\test-llm-integration.mjs
 * ```
 *
 * ## mock 的 chunk 形状**照抄类型定义**
 *
 * `StreamChunk` 是判别联合：`{type:'block-start'|'text-delta'|…}`。`stream()`
 * 的实现是 `yield item.value`（直接转发 adapter 的 chunk，**不包 `{time,chunk}`**
 * —— 那层包装属于 `expandAssistantStream`，见 `dsh-llm/lib/index.js`）。
 * 所以 mock 必须 yield 裸 `StreamChunk`。
 */
import { pathToFileURL } from "node:url";

const ROOT = "E:/deepseek工作区/dsh-herta";

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

const { callSupervisor } = await import(pathToFileURL(`${ROOT}/src/host/supervisor-llm.js`).href);
const { distillFeian } = await import(pathToFileURL(`${ROOT}/src/host/dream-distill-llm.js`).href);

/**
 * 造一个假的 llm 服务。
 * `replies` 按调用顺序取；每个元素是要让模型「说」的文本。
 */
function makeFakeLlm(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    llm: {
      // eslint-disable-next-line require-yield
      async *stream(options) {
        calls.push({ system: options.system, messages: options.messages, maxTokens: options.maxTokens });
        const text = replies[Math.min(i, replies.length - 1)] ?? "";
        i += 1;
        // 照 StreamChunk 的判别联合形状逐块发。
        yield { type: "block-start", index: 0, blockType: "text" };
        for (const piece of String(text).match(/[\s\S]{1,12}/g) ?? []) {
          yield { type: "text-delta", index: 0, text: piece };
        }
        yield { type: "block-end", index: 0, block: { type: "text", text: String(text) } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
}

const ROUTE = { provider: "deepseek-official", model: "deepseek-flash" };

console.log("=== callSupervisor：判决通过 ===");
{
  const fake = makeFakeLlm(['{"verdict":"pass"}']);
  const r = await callSupervisor({
    ctx: { llm: fake.llm },
    route: ROUTE,
    candidate: "行，放那儿吧。",
    recent: "开拓者：帮我记一下",
  });
  ok(r?.verdict === "pass", "判决解析为 pass", JSON.stringify(r));
  ok(fake.calls.length === 1, "只调用一次模型");
  ok(fake.calls[0].system.includes("核"), "system 用复核提示");
  ok(
    fake.calls[0].messages[0].content[0].text.includes("行，放那儿吧。"),
    "候选台词进入 user 消息",
  );
}

console.log("\n=== callSupervisor：判决否决（带因由）===");
{
  const fake = makeFakeLlm(['{"verdict":"veto","reason":"她说写了文件但没有写入工具调用"}']);
  const r = await callSupervisor({ ctx: { llm: fake.llm }, route: ROUTE, candidate: "我记下来了。" });
  ok(r?.verdict === "veto", "判决解析为 veto");
  ok(r?.reason.includes("没有写入工具调用"), "因由完整传回", r?.reason);
}

console.log("\n=== callSupervisor：失败一律放行（不让她说不出话）===");
{
  const fake = makeFakeLlm(["这不是 JSON"]);
  const r = await callSupervisor({ ctx: { llm: fake.llm }, route: ROUTE, candidate: "x" });
  ok(r === null, "看不懂的输出 → null（调用方据此放行）");
}
{
  const noLlm = await callSupervisor({ ctx: {}, route: ROUTE, candidate: "x" });
  ok(noLlm === null, "宿主没有 llm 服务 → null");
}
{
  const fake = makeFakeLlm(['{"verdict":"veto"}']);
  const noRoute = await callSupervisor({ ctx: { llm: fake.llm }, route: null, candidate: "x" });
  ok(noRoute === null, "没有路由 → null（不猜模型）");
  ok(fake.calls.length === 0, "没有路由时**根本没发起调用**");
}
{
  // 流中途抛错
  const brokenLlm = {
    async *stream() {
      yield { type: "text-delta", index: 0, text: "半截" };
      throw new Error("连接断了");
    },
  };
  const r = await callSupervisor({ ctx: { llm: brokenLlm }, route: ROUTE, candidate: "x" });
  ok(r === null, "流抛错 → null（吞掉异常，不让她崩）");
}
{
  // finish.kind 不是 stop（如 max-tokens）时文本不可信 → 放行
  const cutLlm = {
    async *stream() {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: '{"verdict":"veto","reason":"x"}' };
      yield { type: "block-end", index: 0, block: { type: "text", text: '{"verdict":"veto"}' } };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    },
  };
  const r = await callSupervisor({ ctx: { llm: cutLlm }, route: ROUTE, candidate: "x" });
  ok(r === null, "finish 不是 stop（截断）→ 放行，不用不可信的文本判她");
}

console.log("\n=== distillFeian：两阶段全通 ===");
{
  const body = "（我 说）行，放那儿吧。（/我 说）\n\n" + "他问了个不值得回答的问题。".repeat(12);
  const fake = makeFakeLlm(['{"worthy":true}', JSON.stringify({ title: "不值得回答的问题", body })]);
  const r = await distillFeian({
    ctx: { llm: fake.llm },
    route: ROUTE,
    excerpt: "开拓者：这个怎么用\n她：不值得回答。",
    existingTitles: ["旧的标题"],
  });
  ok(r.ok === true, "蒸馏成功", JSON.stringify(r).slice(0, 120));
  ok(r.title === "不值得回答的问题", "标题解析");
  ok(r.body.includes("（我 说）"), "正文保留围栏");
  ok(fake.calls.length === 2, "正好两次调用（worthiness → generation）");
  ok(fake.calls[0].system.includes("值得"), "第一次是 worthiness 提示");
  ok(fake.calls[1].system.includes("废案"), "第二次是 generation 提示");
  ok(fake.calls[0].system.includes("旧的标题"), "已有标题进入 worthiness（供去重）");
  ok(fake.calls[1].system.includes("旧的标题"), "已有标题进入 generation");
}

console.log("\n=== distillFeian：判不值得就**不硬造** ===");
{
  const fake = makeFakeLlm(['{"worthy":false,"reason":"全程事务性，没有她的判断"}']);
  const r = await distillFeian({ ctx: { llm: fake.llm }, route: ROUTE, excerpt: "跑了个测试" });
  ok(r.ok === false, "拒收");
  ok(r.stage === "worthiness", "阶段标为 worthiness");
  ok(r.reason.includes("事务性"), "原因传回");
  ok(fake.calls.length === 1, "不值得时**不再发起生成调用**（省一次）");
}
{
  const fake = makeFakeLlm(["看不懂"]);
  const r = await distillFeian({ ctx: { llm: fake.llm }, route: ROUTE, excerpt: "x" });
  ok(r.ok === false && r.stage === "worthiness", "判定解析不了 → 放弃（不硬造记忆）");
}
{
  const fake = makeFakeLlm(['{"worthy":true}', "这不是 JSON"]);
  const r = await distillFeian({ ctx: { llm: fake.llm }, route: ROUTE, excerpt: "x" });
  ok(r.ok === false && r.stage === "generation", "生成阶段坏掉 → 标为 generation");
}
{
  const fake = makeFakeLlm(['{"worthy":true}', JSON.stringify({ title: "T", body: "太短" })]);
  const r = await distillFeian({ ctx: { llm: fake.llm }, route: ROUTE, excerpt: "x" });
  ok(r.ok === false, "正文过短 → 拒收");
}
{
  const r = await distillFeian({ ctx: { llm: makeFakeLlm(['{"worthy":true}']).llm }, route: ROUTE, excerpt: "   " });
  ok(r.ok === false && r.reason.includes("片段"), "没有素材 → 直接拒收，不调模型");
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
