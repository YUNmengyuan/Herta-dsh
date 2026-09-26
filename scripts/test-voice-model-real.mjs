/**
 * 用**真实数据**跑一遍模型安装管线（下载 → 校验 → 解包 → 再校验 → 换入）。
 *
 * 与 `test-voice-model.mjs` 的分工：那个用现造的小归档、默认就跑、不需要任何外部
 * 条件；这个需要本机**已经有一份真的 bundle** ——
 *
 *   HERTA_TTS_REAL_BUNDLE="C:\Users\<你>\AppData\Roaming\Herta\tts\herta-best-e72"
 *   node scripts/test-voice-model-real.mjs
 *
 * （Herta 桌面应用在「设置 → 语音」里下过模型的话，就在上面那个位置。）
 *
 * 它验证的是小归档验不了的东西：真实的 366 个文件 / 116 MB、真实的
 * `manifest.json`（真 SHA-256）、真实的 espeak-ng-data 目录树、真实的长路径，
 * 走完整的流式 gunzip + ustar 解析。
 *
 * 做法：把真实 bundle 自己打成一个 tar.gz 放在**本机 HTTP 服务**上，再拿
 * `downloadVoiceModel` 去下它 —— 唯一的差别是归档的打包格式由本脚本决定，
 * 所以 pin 用本脚本算出来的值（哈希校验那道门照旧生效）。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { verifyBundle } from "../src/host/bundle-verify.js";
import {
  downloadVoiceModel,
  ttsBundleComplete,
  voiceModelPaths,
} from "../src/host/voice-model.js";

const REAL = process.env.HERTA_TTS_REAL_BUNDLE;
if (REAL === undefined || REAL === "") {
  console.error("需要 HERTA_TTS_REAL_BUNDLE=<真实 bundle 目录>");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail === "" ? "" : `  —— ${detail}`}`);
  }
};

console.log("voice-model（真实数据）");
console.log(`来源: ${REAL}`);

// ── 1. 把真实 bundle 打成 tar.gz ─────────────────────────────────────────
const BLOCK = 512;
function header(name, size, type) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8);
  h.write("0000000\0", 108, 8);
  h.write("0000000\0", 116, 8);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  h.write("00000000000\0", 136, 12);
  h.write("        ", 148, 8);
  h.write(type, 156, 1);
  h.write("ustar\0", 257, 6);
  h.write("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(REAL);
files.sort();

const srcFiles = files.map((p) => relative(REAL, p).split(sep).join("/"));
console.log(`源：${files.length} 个文件`);

const parts = [];
let rawBytes = 0;
for (let i = 0; i < files.length; i += 1) {
  const data = readFileSync(files[i]);
  rawBytes += data.length;
  parts.push(header(srcFiles[i], data.length, "0"), data);
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  if (pad > 0) parts.push(Buffer.alloc(pad));
}
parts.push(Buffer.alloc(BLOCK * 2));
const tar = Buffer.concat(parts);
check("tar 里的文件总字节与原目录一致", rawBytes === files.reduce((n, p) => n + statSync(p).size, 0));

const gz = gzipSync(tar, { level: 6 });
const sha = createHash("sha256").update(gz).digest("hex");
console.log(`归档：${gz.length} B（${(gz.length / 1048576).toFixed(1)} MiB），sha256=${sha.slice(0, 16)}…`);

// ── 2. 本机 HTTP 服务 ───────────────────────────────────────────────────
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(gz.length) });
  // 分块吐，顺带把流式解包那段也走到
  const size = 256 * 1024;
  let i = 0;
  const push = () => {
    while (i < gz.length) {
      const chunk = gz.subarray(i, i + size);
      i += chunk.length;
      if (!res.write(chunk)) return res.once("drain", push);
    }
    res.end();
  };
  push();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── 3. 走完整管线 ───────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "herta-real-"));
const bundleId = "herta-best-e72";
const t0 = Date.now();
let progressMax = 0;
let result = null;
let error = null;
try {
  result = await downloadVoiceModel({
    root,
    bundleId,
    archive: { url: `http://127.0.0.1:${port}/real.tar.gz`, sha256: sha, bytes: gz.length, unpackedBytes: rawBytes + (1 << 20) },
    fetch: (url, init) => fetch(url, init),
    signal: new AbortController().signal,
    onProgress: (n) => {
      progressMax = n;
    },
  });
} catch (err) {
  error = err;
}
const secs = (Date.now() - t0) / 1000;
server.close();

const finalDir = voiceModelPaths(root, bundleId).final;
console.log(`\n管线耗时 ${secs.toFixed(1)}s，进度最后到 ${progressMax} B`);
check("下载+安装没有抛错", error === null, error === null ? "" : String(error));
check("进度走到归档全长", progressMax === gz.length);
const manifestBytes = statSync(join(REAL, "manifest.json")).size;
check(
  "verifyBundle 的字节数 = 源目录总字节 − manifest.json（manifest 不列自己）",
  result !== null && result.bytes + manifestBytes === rawBytes,
  JSON.stringify({ result, rawBytes, manifestBytes }),
);

const verdict = await verifyBundle(finalDir, bundleId);
check("装完之后 verifyBundle 通过（真实 366 个 SHA-256）", verdict.ok === true, JSON.stringify(verdict));
check("装完之后 ttsBundleComplete 为真", ttsBundleComplete(finalDir));
check("manifest.json 也在", readdirSync(finalDir).includes("manifest.json"));
check("espeak-ng-data 目录树在", statSync(join(finalDir, "frontend", "espeak-ng-data")).isDirectory());
check("临时文件没有残留", !readdirSync(root).some((n) => n.endsWith(".download") || n.endsWith(".installing")));

// 逐文件对账：解出来的树必须与源目录**完全一致**（路径集合 + 每个文件的字节数）
let mismatch = 0;
let checked = 0;
const walkOut = (dir, prefix) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      walkOut(p, rel);
      continue;
    }
    checked += 1;
    const srcP = join(REAL, ...rel.split("/"));
    try {
      if (statSync(p).size !== statSync(srcP).size) mismatch += 1;
    } catch {
      mismatch += 1;
    }
  }
};
walkOut(finalDir, "");
check(`解出的 ${checked} 个文件与源目录逐个对账无差异`, checked === files.length && mismatch === 0, `mismatch=${mismatch} checked=${checked} expected=${files.length}`);

// 内容抽样比对（挑三个真实文件比字节）
let same = 0;
for (const rel of ["manifest.json", "voices.bin", "frontend/tokens.txt"]) {
  const a = readFileSync(join(REAL, ...rel.split("/")));
  const b = readFileSync(join(finalDir, ...rel.split("/")));
  if (Buffer.compare(a, b) === 0) same += 1;
}
check("抽三个文件逐字节相同", same === 3, `${same}/3`);

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
