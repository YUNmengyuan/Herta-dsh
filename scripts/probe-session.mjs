/**
 * 会话记录探测器 —— 回答「她到底说没说过这句话 / 叙述层有没有介入」。
 *
 * ## 为什么需要它
 *
 * DSH 的会话文件是 `session.v3.jsonl.zstd`，而且**不是单个 zstd 流** ——
 * 是**多帧拼接**（每帧一行）。一次性 `zstdDecompressSync` 只会解出第一帧
 * （我一开始就踩了这个坑：解出 1 行，还以为是空会话）。所以这里按 zstd 魔数
 * （`28 B5 2F FD`）切帧，逐帧解压再拼。
 *
 * 用法：
 * ```powershell
 * node scripts\probe-session.mjs <session.v3.jsonl.zstd> [--tail N] [--find 关键词]
 * ```
 *
 * - 默认：打印帧数、事件类型分布、以及叙述层特征命中计数
 * - `--tail N`：额外打印最后 N 条消息（用户 / 她）
 * - `--find 词`：额外打印包含该词的消息（用来定位「她有没有说过 X」）
 *
 * **只读**：不改任何文件。默认不打印正文（会话内容可能是私密的），
 * 只有显式给 `--tail` / `--find` 才打印，且截断到 200 字符。
 *
 * ## 会话文件在哪
 *
 * ```
 * <DSH_HOME>/sessions/<工作区目录名>/<session-id>/session.v3.jsonl.zstd
 * ```
 * 正式环境：`%USERPROFILE%\.dsh\sessions\...`
 * lab：`$DSH_HOME\sessions\...`
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith("--"));
if (path === undefined) {
  console.error("用法: node probe-session.mjs <session.v3.jsonl.zstd> [--tail N] [--find 关键词]");
  process.exit(2);
}
const tailIdx = argv.indexOf("--tail");
const tailN = tailIdx >= 0 ? Number(argv[tailIdx + 1] ?? 8) : 0;
const findIdx = argv.indexOf("--find");
const findWord = findIdx >= 0 ? String(argv[findIdx + 1] ?? "") : "";

const buf = readFileSync(path);

// zstd 帧魔数 28 B5 2F FD —— 按它切帧，逐帧解压。
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let i = buf.indexOf(MAGIC, 0);
while (i >= 0) {
  offsets.push(i);
  i = buf.indexOf(MAGIC, i + 4);
}
console.log(`zstd 帧数: ${offsets.length}（文件 ${(buf.length / 1024 / 1024).toFixed(2)} MB）`);

const parts = [];
let failed = 0;
for (let k = 0; k < offsets.length; k += 1) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  try {
    parts.push(zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
  } catch {
    failed += 1;
  }
}
const text = parts.join("\n");
console.log(`解出 ${parts.length} 帧（失败 ${failed}）`);
const lines = text.split("\n").filter((l) => l.trim().length > 0);
console.log(`事件行数: ${lines.length}`);

const types = new Map();
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    const t = o.type ?? "(无 type)";
    types.set(t, (types.get(t) ?? 0) + 1);
  } catch {
    /* 忽略不完整行 */
  }
}
console.log("\n事件类型分布（前 14）:");
[...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([t, n]) => console.log(`  ${t}: ${n}`));

// 叙述层特征：这些字符串**只有本插件的叙述层会写进会话**。
const marks = {
  "她的人物设定（黑塔/天才俱乐部）": /天才俱乐部|黑塔/,
  "herta_dream 工具": /herta_dream/,
  "herta_speak 工具": /herta_speak/,
  "herta_memory_save 工具": /herta_memory_save/,
  "叙述层 steer：复核结果（= 否决过）": /【记录 · 复核结果】/,
  "叙述层 steer：分拍现场": /【记录 · 现场】/,
  "她的围栏（我 说）": /（我 说）/,
  "她的围栏（我 想）": /（我 想）/,
  "复核判决 JSON": /"verdict"\s*:\s*"(pass|veto)"/,
  "蒸馏 worthy JSON": /"worthy"\s*:/,
  ".herta 路径": /\.herta/,
};
console.log("\n特征命中:");
for (const [name, re] of Object.entries(marks)) {
  const n = (text.match(new RegExp(re.source, "g")) ?? []).length;
  console.log(`  ${n > 0 ? "✅" : "  "} ${name}: ${n}`);
}

/** 抽出用户/她的消息文本（只取 text 块）。 */
const msgs = [];
for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  if (o.type !== "user/message" && o.type !== "assistant/message") continue;
  const d = o.data ?? {};
  const content = d.message?.content ?? d.content ?? [];
  const txt = (Array.isArray(content) ? content : [])
    .filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (txt.length === 0) continue;
  msgs.push({ seq: o.seq, type: o.type, turn: d.turn, txt });
}

if (tailN > 0) {
  console.log(`\n最后 ${tailN} 条消息:`);
  for (const m of msgs.slice(-tailN)) {
    console.log(`  [seq ${m.seq} turn ${m.turn ?? "-"}] ${m.type === "user/message" ? "用户" : "她"}: ${m.txt.slice(0, 200)}`);
  }
}

if (findWord.length > 0) {
  const hits = msgs.filter((m) => m.txt.includes(findWord));
  console.log(`\n包含「${findWord}」的消息: ${hits.length} 条`);
  for (const m of hits.slice(-8)) {
    console.log(`  [seq ${m.seq} turn ${m.turn ?? "-"}] ${m.type === "user/message" ? "用户" : "她"}: ${m.txt.slice(0, 200)}`);
  }
}
