/**
 * 本地语音模型下载路径的单测。
 *
 * 覆盖的是**真正会出错的地方**，而不是「函数被调用了」：
 *   · 归档先比字节数、再比 SHA-256 —— 两个都要能拦住
 *   · 解包只认 ustar 的普通文件与目录，拒绝路径穿越
 *   · 装完之后必须过 `ttsBundleComplete`（必需文件 + espeak-ng-data 目录 + manifest 对账）
 *   · 失败**绝不留半个可用 bundle**，且已装好的旧 bundle 在任何失败下都活着
 *   · 服务的状态机：absent → downloading → ready，以及取消
 *
 * 不联网：归档是测试自己用小 tar 写入器现造再 gzip 的，fetch 是假的。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  VoiceModelError,
  createVoiceModelService,
  downloadVoiceModel,
  removeVoiceModel,
  ttsBundleComplete,
  voiceModelPaths,
} from "../src/host/voice-model.js";
import { extractTar, safeEntryPath } from "../src/host/tar-extract.js";
import { verifyBundle } from "../src/host/bundle-verify.js";
import { REQUIRED_FILES, TTS_ARCHIVE_BYTES, TTS_BUNDLE_ID, resolveArchive } from "../src/host/tts-release.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail === "" ? "" : `  —— ${detail}`}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "herta-voice-model-"));
const enc = (s) => Buffer.from(s, "utf8");

// ── 小 tar 写入器（ustar，普通文件 + 目录）──────────────────────────────────
const BLOCK = 512;

function header(name, size, type) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8);
  h.write("0000000\0", 108, 8);
  h.write("0000000\0", 116, 8);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  h.write("00000000000\0", 136, 12);
  h.write("        ", 148, 8); // checksum 位置先填空格，和读取端算法一致
  h.write(type, 156, 1);
  h.write("ustar\0", 257, 6);
  h.write("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

function tarOf(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.dir === true) {
      // 目录条目的名字**不带尾斜杠** —— 与上游 tar-pack.mjs 一致：
      // 读取端（也是上游的）把空路径段一律判为不安全，`a/` 会被拒。
      parts.push(header(e.name, 0, "5"));
      continue;
    }
    const data = Buffer.isBuffer(e.data) ? e.data : enc(e.data);
    parts.push(header(e.name, data.length, "0"));
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // 结束标记
  return Buffer.concat(parts);
}

/** 造一个能过门的 bundle：必需文件都在、espeak 是目录、manifest 对得上。 */
function makeBundle(release = TTS_BUNDLE_ID, extra = []) {
  const files = [
    { name: "model.int8-81mb.onnx", data: "MODEL-BYTES" },
    { name: "voices.bin", data: "VOICES" },
    { name: "frontend/tokens.txt", data: "TOK" },
    { name: "frontend/lexicon-us-en.txt", data: "LEX-EN" },
    { name: "frontend/lexicon-zh.txt", data: "LEX-ZH" },
    { name: "frontend/phone-zh.fst", data: "PHONE" },
    { name: "frontend/date-zh.fst", data: "DATE" },
    { name: "frontend/number-zh.fst", data: "NUM" },
  ];
  const manifestFiles = files.map((f) => {
    const buf = enc(f.data);
    return { path: f.name, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  });
  const manifest = JSON.stringify(
    { schema: 1, release, model: "int8-81mb", runtime_voice: "af_heart", files: manifestFiles },
    null,
    2,
  );
  const entries = [
    { name: "frontend", dir: true },
    { name: "frontend/espeak-ng-data", dir: true },
    ...files,
    { name: "manifest.json", data: manifest },
    ...extra,
  ];
  return gzipSync(tarOf(entries));
}

/** 假 fetch：按固定块吐字节。 */
function fakeFetch(buf, { status = 200, chop = 0 } = {}) {
  const body = chop > 0 ? buf.subarray(0, buf.length - chop) : buf;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    body: stream(body),
  });
}

/** 把 Buffer 变成分块的异步可迭代（`extractTar` 的入参形态）。 */
function stream(buf) {
  return (async function* chunks() {
    const size = 64 * 1024;
    for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
  })();
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const signal = () => new AbortController().signal;
const opts = (archive, fetch, sub) => ({
  root: join(root, sub),
  bundleId: TTS_BUNDLE_ID,
  archive,
  fetch,
  signal: signal(),
  onProgress: () => {},
});

console.log("voice-model");

// 1. 路径
{
  const p = voiceModelPaths("/store", "b1");
  check("paths.final = <root>/<id>", p.final.endsWith("b1"));
  check("paths.installing 在最终目录旁边", p.installing.endsWith("b1.installing"));
  check("paths.download 在最终目录旁边", p.download.endsWith("b1.download"));
}

// 2. pin 参数自洽
{
  check("bundle id 是 herta-best-e72", TTS_BUNDLE_ID === "herta-best-e72");
  check("归档地址指向上游 release", resolveArchive().url.includes("PersonaCLI/Herta/releases/download/voice-herta-best-e72"));
  check("归档体积是 76,255,506", TTS_ARCHIVE_BYTES === 76255506);
  check("必需文件清单含模型与 voices.bin", REQUIRED_FILES.includes("model.int8-81mb.onnx") && REQUIRED_FILES.includes("voices.bin"));
  const old = process.env.HERTA_TTS_ARCHIVE_URL;
  process.env.HERTA_TTS_ARCHIVE_URL = "http://127.0.0.1:1/x.tar.gz";
  check("环境变量可覆盖地址（内容仍由 pin 约束）", resolveArchive().url === "http://127.0.0.1:1/x.tar.gz" && resolveArchive().overridden === true);
  if (old === undefined) delete process.env.HERTA_TTS_ARCHIVE_URL;
  else process.env.HERTA_TTS_ARCHIVE_URL = old;
}

// 3. tar：路径安全
{
  check("正常相对路径放行", safeEntryPath("/d", "a/b.txt").replace(/\\/g, "/").endsWith("/d/a/b.txt"));
  for (const bad of ["../evil", "a/../../evil", "/abs", "a/./b", "a//b", "a\\b", ""]) {
    let threw = false;
    try {
      safeEntryPath("/d", bad);
    } catch {
      threw = true;
    }
    check(`拒绝不安全路径 ${JSON.stringify(bad)}`, threw);
  }
}

// 4. tar：解包
{
  const dest = join(root, "tar-out");
  const tar = tarOf([{ name: "d", dir: true }, { name: "d/f.txt", data: "hi" }]);
  await extractTar(stream(tar), dest, { maxBytes: 1 << 20 });
  check("解出文件内容", readFileSync(join(dest, "d", "f.txt"), "utf8") === "hi");

  // 炸弹上限
  let over = false;
  try {
    await extractTar(stream(tar), join(root, "tar-over"), { maxBytes: 1 });
  } catch {
    over = true;
  }
  check("超过 maxBytes 被拒", over);

  // 穿越
  let escape = false;
  try {
    await extractTar(stream(tarOf([{ name: "../escape.txt", data: "x" }])), join(root, "tar-escape"), { maxBytes: 1 << 20 });
  } catch {
    escape = true;
  }
  check("归档里的 ../ 被拒", escape);

  // 截断
  let truncated = false;
  const full = tarOf([{ name: "a.txt", data: "0123456789" }]);
  try {
    await extractTar(stream(full.subarray(0, full.length - 600)), join(root, "tar-trunc"), { maxBytes: 1 << 20 });
  } catch {
    truncated = true;
  }
  check("截断的归档被拒", truncated);
}

// 5. 下载：happy path
{
  const gz = makeBundle();
  const archive = { url: "https://example.invalid/x.tar.gz", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 };
  const o = opts(archive, fakeFetch(gz), "happy");
  const progress = [];
  o.onProgress = (r) => progress.push(r);
  const res = await downloadVoiceModel(o);
  const final = voiceModelPaths(o.root, TTS_BUNDLE_ID).final;
  check("装完之后 ttsBundleComplete 为真", ttsBundleComplete(final));
  check("返回文件数与字节数", res.files > 0 && res.bytes > 0);
  check("进度回调被调用过且最后一次等于总长", progress.length > 0 && progress.at(-1) === gz.length);
  check(
    "临时文件都被清掉",
    !(await pathExists(`${final}.download`)) && !(await pathExists(`${final}.installing`)),
  );
}

// 6. 下载：哈希不符 —— 内容变了，字节数不变
{
  const gz = makeBundle();
  const tampered = Buffer.from(gz);
  tampered[tampered.length - 30] ^= 0xff;
  const archive = { url: "u", sha256: sha(gz), bytes: tampered.length, unpackedBytes: 1 << 20 };
  const o = opts(archive, fakeFetch(tampered), "hash");
  let reason = null;
  try {
    await downloadVoiceModel(o);
  } catch (err) {
    reason = err instanceof VoiceModelError ? err.reason : String(err);
  }
  check("哈希不符 → reason=hash", reason === "hash", String(reason));
  check("失败后没有留下 bundle", !ttsBundleComplete(voiceModelPaths(o.root, TTS_BUNDLE_ID).final));
}

// 7. 下载：多收字节
{
  const gz = makeBundle();
  const archive = { url: "u", sha256: sha(gz), bytes: gz.length - 10, unpackedBytes: 1 << 20 };
  let reason = null;
  try {
    await downloadVoiceModel(opts(archive, fakeFetch(gz), "size"));
  } catch (err) {
    reason = err?.reason;
  }
  check("超出钉住的字节数 → reason=size", reason === "size", String(reason));
}

// 8. 下载：少了字节
{
  const gz = makeBundle();
  const archive = { url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 };
  let reason = null;
  try {
    await downloadVoiceModel(opts(archive, fakeFetch(gz, { chop: 500 }), "short"));
  } catch (err) {
    reason = err?.reason;
  }
  check("字节数不足 → reason=size", reason === "size", String(reason));
}

// 9. 下载：HTTP 非 2xx
{
  const gz = makeBundle();
  const archive = { url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 };
  let reason = null;
  try {
    await downloadVoiceModel(opts(archive, fakeFetch(gz, { status: 404 }), "http"));
  } catch (err) {
    reason = err?.reason;
  }
  check("HTTP 404 → reason=http", reason === "http", String(reason));
}

// 10. 下载：manifest 的 release 不是这一版 → verify
{
  const gz = makeBundle("some-other-release");
  const archive = { url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 };
  let reason = null;
  try {
    await downloadVoiceModel(opts(archive, fakeFetch(gz), "verify"));
  } catch (err) {
    reason = err?.reason;
  }
  check("release 不符 → reason=verify", reason === "verify", String(reason));
}

// 11. 下载：manifest 列的体积对不上 → verify
{
  const gz = makeBundle(TTS_BUNDLE_ID, [
    { name: "model.int8-81mb.onnx", data: "MODEL-BYTES-CHANGED" },
  ]);
  const archive = { url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 };
  let reason = null;
  try {
    await downloadVoiceModel(opts(archive, fakeFetch(gz), "verify2"));
  } catch (err) {
    reason = err?.reason;
  }
  check("同名文件体积不符 → reason=verify（tar 后写覆盖）", reason === "verify", String(reason));
}

// 12. verifyBundle 直接测
{
  const dir = join(root, "vb");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ release: "r", model: "m", files: [] }));
  const empty = await verifyBundle(dir, "r");
  check("空 manifest → 拒", empty.ok === false && empty.reason === "empty manifest");
  check("release 不符 → 拒", (await verifyBundle(dir, "other")).ok === false);
  check("读不到 manifest → 拒", (await verifyBundle(join(root, "nope"), "r")).ok === false);
}

// 13. 已装好的旧 bundle 在任何失败下都活着
{
  const gz = makeBundle();
  const o = opts({ url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 }, fakeFetch(gz), "survive");
  await downloadVoiceModel(o);
  const final = voiceModelPaths(o.root, TTS_BUNDLE_ID).final;
  check("先装好一份", ttsBundleComplete(final));

  // 再来一次坏的下载：不同内容、错的哈希
  const bad = Buffer.from(gz);
  bad[0] ^= 0xff;
  let reason = null;
  try {
    await downloadVoiceModel(opts({ url: "u", sha256: sha(gz), bytes: bad.length, unpackedBytes: 1 << 20 }, fakeFetch(bad), "survive"));
  } catch (err) {
    reason = err?.reason;
  }
  check("坏的下载被拒", reason === "hash", String(reason));
  check("旧 bundle 仍然完好", ttsBundleComplete(final));
}

// 14. 服务状态机
{
  const gz = makeBundle();
  const store = join(root, "service");
  const states = [];
  const svc = createVoiceModelService({
    root: store,
    bundleId: TTS_BUNDLE_ID,
    archive: { url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 },
    fetch: fakeFetch(gz),
    onChange: (s) => states.push(s.phase),
    log: () => {},
  });
  check("初始 absent", svc.state().phase === "absent");
  check("absent 时就带上了钉住的体积", svc.state().totalBytes === gz.length);
  await svc.download();
  check("下完 ready", svc.state().phase === "ready");
  check("经过 downloading", states.includes("downloading"));
  check("ttsBundleComplete 为真", ttsBundleComplete(join(store, TTS_BUNDLE_ID)));
  await svc.remove();
  check("删除后回到 absent", svc.state().phase === "absent");
  check("目录真的没了", !ttsBundleComplete(join(store, TTS_BUNDLE_ID)));
}

// 15. 取消（确定性：等真的进入 downloading 才取消，不靠 setTimeout 赌时序）
{
  const gz = makeBundle();
  const store = join(root, "cancel");
  const svc = createVoiceModelService({
    root: store,
    bundleId: TTS_BUNDLE_ID,
    archive: { url: "u", sha256: sha(gz), bytes: gz.length, unpackedBytes: 1 << 20 },
    // 一个「卡住」的响应：不吐数据，直到被 abort。
    fetch: async (url, init) => ({
      ok: true,
      status: 200,
      body: (async function* stuck() {
        await new Promise((resolve) => {
          if (init.signal.aborted) return resolve();
          init.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })(),
    }),
    log: () => {},
  });
  const p = svc.download();
  while (svc.state().phase !== "downloading") await new Promise((r) => setTimeout(r, 1));
  check("开始后进入 downloading", svc.state().phase === "downloading");
  svc.cancel();
  const s = await p;
  check("取消后不是 ready", s.phase !== "ready", s.phase);
  check("取消后没留下 bundle", !ttsBundleComplete(join(store, TTS_BUNDLE_ID)));
}

// 16. 服务会清掉上次崩溃留下的半成品
{
  const store = join(root, "sweep");
  const paths = voiceModelPaths(store, TTS_BUNDLE_ID);
  mkdirSync(paths.installing, { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(paths.download, "half");
  const svc = createVoiceModelService({ root: store, bundleId: TTS_BUNDLE_ID, fetch: async () => ({ ok: false, status: 500, body: null }), log: () => {} });
  await svc.sweep();
  check("残留的 .installing 被清", !(await pathExists(paths.installing)));
  check("残留的 .download 被清", !(await pathExists(paths.download)));
}
{
  const store = join(root, "nobundle");
  const svc = createVoiceModelService({ root: store, bundleId: TTS_BUNDLE_ID, fetch: async () => ({ ok: false, status: 500, body: null }), log: () => {} });
  check("removeVoiceModel 对不存在的 bundle 不抛", await removeVoiceModel(store, TTS_BUNDLE_ID).then(() => true).catch(() => false));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

async function pathExists(p) {
  const { existsSync } = await import("node:fs");
  return existsSync(p);
}
