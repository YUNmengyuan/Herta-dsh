/**
 * 本地语音模型（离线 TTS）的**下载 / 校验 / 安装**（对应 Herta 的 ADR 0061）。
 *
 * 移植自 `Herta-src/packages/gui/src/main/tts/voice-model.ts` 与 `tts-path.ts`，
 * 做了三处适配（都在下面就近注明）：
 *   1. 根目录从 `<userData>/tts` 改成 `$DSH_HOME/tts`（DSH 插件的 home 是 DSH_HOME）
 *   2. `fetch` 默认用宿主进程的全局 `fetch`（DSH 宿主是普通 Node 子进程）
 *   3. 网络失败时补一条**可操作**的提示（见 NETWORK_HINT）
 *
 * ## 为什么值得照搬它整套流程
 *
 * 上游把「下载」做成了四段，每段都有明确的失败语义，且**任何失败都不会留下
 * 半个可用的 bundle**：
 *
 *   1. 边下边算 SHA-256；**先比字节数、再比哈希**，两者任一不符就中止
 *   2. 解包到**最终目录旁边**的 `.installing/`，并带解压炸弹上限
 *   3. 拿 bundle 自带的 `manifest.json` **逐个文件比 size + SHA-256**，还要
 *      比 release id 是不是这一版期望的那个
 *   4. 只有前三段全过，才 `rename` 就位 —— 于是「读到的要么是旧的完整版，
 *      要么是新的完整版」，不存在中间态
 *
 * 这个文件里 `ttsBundleComplete()` 是**启动/读状态时**的轻量检查（只看存在与
 * 体积，不算哈希）；重的哈希校验只在安装那一次做。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { isManifest, verifyBundle } from "./bundle-verify.js";
import { extractTar } from "./tar-extract.js";
import { REQUIRED_FILES, TTS_BUNDLE_ID, resolveArchive } from "./tts-release.js";

/** 四个阶段，与上游 `VoiceModelPhase` 逐字一致（客户端按这四个值渲染）。 */
export const VOICE_MODEL_PHASES = Object.freeze([
  "absent",
  "downloading",
  "ready",
  "failed",
]);

/** 下载失败的原因码 —— 是**键**不是消息：设置面板自己本地化，用户不会去读堆栈。 */
export const VOICE_MODEL_FAILURES = Object.freeze([
  "network",
  "http",
  "size",
  "hash",
  "archive",
  "verify",
  "disk",
  "cancelled",
]);

/**
 * 网络失败时额外打的一条日志。
 *
 * 本机实测：这台机器上 git / GitHub 的 TLS 被中间拦截，普通 Node 的 `fetch`
 * 会直接 `fetch failed`，加 `--use-system-ca` 才通（仓库交接文档里早记过）。
 * DSH 宿主是 Electron 拉起的**普通 Node 子进程**，所以插件里的 fetch 也吃这一条。
 * 与其让用户对着 "network" 发呆，不如直接把钥匙给出来。
 */
const NETWORK_HINT =
  "如果本机对 GitHub 的 TLS 有中间拦截，给 DSH 宿主加 `NODE_OPTIONS=--use-system-ca` 再启动";

/** 模型仓库根：`$DSH_HOME/tts`（上游是 `<userData>/tts`）。 */
export function voiceModelStoreRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "tts");
}

/** 一个 bundle id 在根下占用的三个路径：最终目录、解包中、下载中。 */
export function voiceModelPaths(root, bundleId) {
  return {
    final: join(root, bundleId),
    installing: join(root, `${bundleId}.installing`),
    download: join(root, `${bundleId}.download`),
  };
}

/**
 * `modelRoot` 里是不是一个**可用**的 bundle：清单里的必需文件都在且非空，
 * `frontend/espeak-ng-data` 是个目录，并且 —— 当 bundle 自带 manifest 时
 * （下载来的都带）—— 里面对每个文件的大小都对得上。
 *
 * 只看体积不算哈希：这个函数每次启动、每次读状态都会跑。尽力而为，任何 fs
 * 错误都当 false。
 */
export function ttsBundleComplete(modelRoot) {
  try {
    for (const rel of REQUIRED_FILES) {
      const p = join(modelRoot, rel);
      if (!existsSync(p)) return false;
      const st = statSync(p);
      if (!st.isFile() || st.size === 0) return false;
    }
    const espeak = join(modelRoot, "frontend", "espeak-ng-data");
    if (!existsSync(espeak) || !statSync(espeak).isDirectory()) return false;
    const manifestPath = join(modelRoot, "manifest.json");
    if (existsSync(manifestPath)) {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!isManifest(parsed)) return false;
      for (const f of parsed.files) {
        const parts = f.path.split("/");
        if (parts.some((s) => s === ".." || s === "" || s === ".")) return false;
        const p = join(modelRoot, ...parts);
        if (!existsSync(p) || statSync(p).size !== f.bytes) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 本地磁盘说不 —— 满盘、权限、快坏的盘。
 *
 * 与「传输失败」区分开（上游 2026-09-10 修的）：body 循环里一个 ENOSPC 曾经被
 * 报成 `network`，于是设置面板让用户去查 VPN，而实际上 76 MB 里已经下了 60 MB、
 * 盘满了。
 */
const DISK_CODES = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EIO",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EBUSY",
]);

function isDiskError(err) {
  const code = err?.code;
  return typeof code === "string" && DISK_CODES.has(code);
}

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

/** `rm -rf` 带几次重试：Windows 在最后一个句柄关掉后还会按住目录一小会儿，
 *  而 worker 的模型文件正是这种情况。 */
async function rmRetry(path, attempts = 6) {
  for (let i = 0; ; i += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

async function* abortable(source, signal) {
  for await (const chunk of source) {
    if (signal.aborted) throw new VoiceModelError("cancelled", "cancelled");
    yield chunk;
  }
}

/** 下载失败 —— 带一个原因码。 */
export class VoiceModelError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "VoiceModelError";
    this.reason = reason;
  }
}

/**
 * 下载 → 校验 → 解包 → 再校验 → 换入。成功时 resolve 出 bundle 的体积；
 * 失败时抛 `VoiceModelError`（抛之前临时文件已清掉）。**已经装好的旧 bundle
 * 在任何失败下都活着** —— 它只在最后那一次 rename 时被替换。
 */
export async function downloadVoiceModel(opts) {
  const { archive, signal } = opts;
  const paths = voiceModelPaths(opts.root, opts.bundleId);
  const log = opts.log ?? (() => {});
  const cleanup = async () => {
    await rm(paths.download, { force: true }).catch(() => undefined);
    await rmRetry(paths.installing).catch(() => undefined);
  };
  try {
    await mkdir(opts.root, { recursive: true });
    await cleanup();

    // ── 1. 下到盘上，边下边算哈希 ─────────────────────────────────────────
    let res;
    try {
      res = await opts.fetch(archive.url, { signal });
    } catch (err) {
      if (!(isAbortError(err) || signal.aborted)) log(NETWORK_HINT);
      throw new VoiceModelError(
        isAbortError(err) || signal.aborted ? "cancelled" : "network",
        errorMessage(err),
      );
    }
    if (!res.ok) throw new VoiceModelError("http", `HTTP ${res.status}`);
    const body = res.body;
    if (body === null || body === undefined) {
      throw new VoiceModelError("network", "empty body");
    }
    const hash = createHash("sha256");
    let received = 0;
    const fh = await open(paths.download, "w").catch((err) => {
      throw new VoiceModelError("disk", String(err));
    });
    try {
      for await (const chunk of body) {
        if (signal.aborted) throw new VoiceModelError("cancelled", "cancelled");
        received += chunk.length;
        if (received > archive.bytes) {
          throw new VoiceModelError("size", "archive larger than pinned");
        }
        hash.update(chunk);
        await fh.write(chunk);
        opts.onProgress(received, archive.bytes);
      }
    } catch (err) {
      if (err instanceof VoiceModelError) throw err;
      throw new VoiceModelError(
        isAbortError(err) || signal.aborted
          ? "cancelled"
          : isDiskError(err)
            ? "disk"
            : "network",
        errorMessage(err),
      );
    } finally {
      await fh.close();
    }
    if (received !== archive.bytes) {
      throw new VoiceModelError("size", `got ${received} of ${archive.bytes}`);
    }
    if (hash.digest("hex") !== archive.sha256) {
      throw new VoiceModelError("hash", "archive hash mismatch");
    }

    // ── 2. 解到最终目录旁边 ───────────────────────────────────────────────
    let extracted;
    try {
      const source = createReadStream(paths.download).pipe(createGunzip());
      extracted = await extractTar(
        abortable(source, signal),
        paths.installing,
        // 给 manifest 与块对齐留一点余量；pin 住的哈希已经排除了「另一个归档」，
        // 这一条排的是「pin 错了」。
        { maxBytes: archive.unpackedBytes + (1 << 20) },
      );
    } catch (err) {
      if (err instanceof VoiceModelError) throw err;
      throw new VoiceModelError(
        isDiskError(err) ? "disk" : "archive",
        errorMessage(err),
      );
    }

    // ── 3. 拿它自带的 manifest 逐个文件校验 ───────────────────────────────
    const verdict = await verifyBundle(paths.installing, opts.bundleId);
    if (!verdict.ok) throw new VoiceModelError("verify", verdict.reason);
    if (!ttsBundleComplete(paths.installing)) {
      throw new VoiceModelError("verify", "bundle incomplete");
    }

    // ── 4. 换入 ───────────────────────────────────────────────────────────
    try {
      await rmRetry(paths.final);
      await rename(paths.installing, paths.final);
    } catch (err) {
      throw new VoiceModelError("disk", String(err));
    }
    await rm(paths.download, { force: true }).catch(() => undefined);
    return { files: extracted.files, bytes: verdict.bytes };
  } catch (err) {
    await cleanup();
    if (err instanceof VoiceModelError) throw err;
    throw new VoiceModelError("disk", errorMessage(err));
  }
}

/** 删掉已装的 bundle（以及任何残留）。调用方要先停掉 worker —— 它跑起来时
 *  模型文件是打开着的。 */
export async function removeVoiceModel(root, bundleId) {
  const paths = voiceModelPaths(root, bundleId);
  await rmRetry(paths.final);
  await rmRetry(paths.installing).catch(() => undefined);
  await rm(paths.download, { force: true }).catch(() => undefined);
}

// ───── 设置面板要对话的那个服务 ─────

/**
 * 造一个语音模型服务。
 *
 * @param {object} opts
 * @param {string} opts.root - 存放 bundle 的目录（`$DSH_HOME/tts`）。
 * @param {string} [opts.bundleId] - 默认取这一版 pin 的 bundle。
 * @param {object} [opts.archive] - 默认取 `resolveArchive()`。
 * @param {Function} [opts.fetch] - 可注入的 fetch（测试用）。
 * @param {Function} [opts.onChange] - 每次状态变化（含进度，已节流）。
 * @param {Function} [opts.log] - 日志口。
 */
export function createVoiceModelService(opts) {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const every = opts.progressEveryMs ?? 200;
  const bundleId = opts.bundleId ?? TTS_BUNDLE_ID;
  const archive = opts.archive ?? resolveArchive();
  const doFetch =
    opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const paths = voiceModelPaths(opts.root, bundleId);

  let live = null; // 下载中才有值
  let inFlight = null;
  let controller = null;
  let lastError = null;

  // 上次崩溃留下的 `.installing` / `.download`（最多约 190 MB）以前要等下一次
  // 下载才清；而可能永远没人再下一次（上游 ADR 0061 §4.4）。所以在服务构造时
  // 就扫一次，下载则等这次扫描完成 —— 两者不会去抢同一批路径。
  const swept = (async () => {
    try {
      if (!existsSync(paths.installing) && !existsSync(paths.download)) return;
      await rm(paths.download, { force: true }).catch(() => undefined);
      await rmRetry(paths.installing).catch(() => undefined);
      log(`已清掉 ${opts.root} 下上次残留的半成品`);
    } catch {
      // 尽力而为；下载自己的 cleanup 还会再跑一次
    }
  })();

  const base = (phase) => ({
    phase,
    receivedBytes: 0,
    totalBytes: archive.bytes,
    unpackedBytes: archive.unpackedBytes,
  });

  const state = () => {
    if (live !== null) return live;
    if (ttsBundleComplete(paths.final)) return base("ready");
    return lastError !== null
      ? { ...base("failed"), error: lastError }
      : base("absent");
  };

  const run = async () => {
    const ac = new AbortController();
    controller = ac;
    lastError = null;
    live = base("downloading");
    opts.onChange?.(live);
    let lastPush = now();
    try {
      await swept;
      await downloadVoiceModel({
        root: opts.root,
        bundleId,
        archive,
        fetch: doFetch,
        signal: ac.signal,
        log,
        onProgress: (received, total) => {
          live = { ...base("downloading"), receivedBytes: received, totalBytes: total };
          const t = now();
          if (t - lastPush >= every || received === total) {
            lastPush = t;
            opts.onChange?.(live);
          }
        },
      });
      log(`语音模型 ${bundleId} 已装到 ${paths.final}`);
    } catch (err) {
      const reason = err instanceof VoiceModelError ? err.reason : "disk";
      if (reason !== "cancelled") {
        lastError = reason;
        log(`语音模型下载失败（${reason}）：${errorMessage(err)}`);
      }
    } finally {
      live = null;
      controller = null;
      inFlight = null;
    }
    const s = state();
    opts.onChange?.(s);
    return s;
  };

  return {
    bundleId,
    archive,
    root: opts.root,
    state,
    sweep: () => swept,
    download() {
      if (inFlight !== null) return inFlight;
      const s = state();
      if (s.phase === "ready") return Promise.resolve(s);
      inFlight = run();
      return inFlight;
    },
    cancel() {
      controller?.abort(new DOMException("cancelled", "AbortError"));
    },
    async remove() {
      if (inFlight !== null) {
        controller?.abort(new DOMException("cancelled", "AbortError"));
        await inFlight;
      }
      try {
        await removeVoiceModel(opts.root, bundleId);
        lastError = null;
        log(`语音模型 ${bundleId} 已删除`);
      } catch (err) {
        log(`语音模型删除失败：${String(err)}`);
        lastError = "disk";
      }
      const s = state();
      opts.onChange?.(s);
      return s;
    },
  };
}
