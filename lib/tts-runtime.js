/**
 * 本地 TTS 的**运行时**：探测 + 合成入口（宿主侧）。
 *
 * 运行时本体（sherpa-onnx 1.13.6 的原生件 + JS glue，22 MB）随包分发在
 * `assets/tts-runtime/`，来源与授权见 `THIRD-PARTY.md` 与那里的 `LICENSES/`。
 *
 * ## `runtime` 这个标志必须是**证明出来的**，不能写死
 *
 * 设置面板把两件事都 gate 在它上面：
 *   · 「下载模型」按钮        `disabled={!runtime}`（`VoiceSettings.tsx:489/506`）
 *   · 「实时语音」开关        `canSpeak = bundle && runtime && !failed`
 *
 * 写死成 true 的代价是仓库别处已经吃过一次的教训：面板显示「已就绪」，
 * 而她一个音也发不出来。所以这里走**真的探测** —— 拉一个子进程把 addon 加载起来，
 * 拿到版本号才算数。探测结果缓存（进程内一次）。
 *
 * 探测与合成都在**子进程**里跑，理由见 `tts-worker.cjs` 的文件头
 * （非 ASCII 路径 / 同步阻塞 / 原生件崩溃隔离）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TTS_MODEL_FILE } from "./tts-release.js";
import { voiceModelPaths, voiceModelStoreRoot } from "./voice-model.js";
import { TTS_BUNDLE_ID } from "./tts-release.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 运行时目录。两种布局都要认：
 *   · 部署后：`lib/` 与 `assets/` 同级 → `lib/../assets/tts-runtime`
 *   · 源码里：`src/host/` 往上两层才是包根 → `<repo>/assets/tts-runtime`
 * 取第一个真实存在的；都不在就返回部署布局那条（让错误信息指向预期位置）。
 */
function resolveRuntimeDir() {
  const candidates = [
    join(HERE, "..", "assets", "tts-runtime"),
    join(HERE, "..", "..", "assets", "tts-runtime"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export const TTS_RUNTIME_DIR = resolveRuntimeDir();

/** 子进程执行体。`build.mjs` 会把 `.cjs` 一起拷进 `lib/`。 */
const WORKER = join(HERE, "tts-worker.cjs");

/** 合成超时：模型加载 + 一句话推理，给足分钟级余量。 */
const SYNTH_TIMEOUT_MS = 180_000;
/** 探测超时：只加载 addon，不该慢。 */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * 拉一次子进程跑 worker。
 *
 * 配置走**临时 JSON 文件**而不是命令行参数：合成文本是中文，命令行转义在
 * Windows 上很容易被搞坏（而且会进进程列表）。
 *
 * @param {object} config - worker 的 JSON 配置。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<object>} worker 回的那一行 JSON。
 */
function runWorker(config, timeoutMs) {
  return new Promise((resolve) => {
    if (!existsSync(WORKER)) {
      resolve({ ok: false, error: `找不到 worker：${WORKER}` });
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "herta-tts-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");

    const child = spawn(process.execPath, [WORKER, configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `worker 超时（${timeoutMs} ms）` });
    }, timeoutMs);

    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("error", (e) => finish({ ok: false, error: String(e?.message ?? e) }));
    child.on("close", () => {
      // worker 正常时 stdout 恰好一行 JSON；异常时可能一行都没有。
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (line === undefined) {
        finish({ ok: false, error: `worker 没有输出${err === "" ? "" : `：${err.trim().slice(0, 300)}`}` });
        return;
      }
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ ok: false, error: `worker 输出不是 JSON：${line.slice(0, 200)}` });
      }
    });
  });
}

/** 探测结果缓存 —— 进程内一次，之后零成本。 */
let probeCache = null;

/**
 * 探测运行时可用性。**不是查文件在不在，是真的把它加载起来。**
 *
 * @param {{force?: boolean}} [options] - `force` 绕过缓存。
 * @returns {Promise<{available: boolean, version?: string|null, onnxruntime?: string|null, error?: string, dir: string}>}
 */
export async function probeTtsRuntime(options = {}) {
  if (probeCache !== null && options.force !== true) return probeCache;

  if (!existsSync(TTS_RUNTIME_DIR)) {
    probeCache = { available: false, dir: TTS_RUNTIME_DIR, error: "运行时没有随包分发" };
    return probeCache;
  }
  const res = await runWorker({ runtimeDir: TTS_RUNTIME_DIR, mode: "probe" }, PROBE_TIMEOUT_MS);
  probeCache =
    res.ok === true
      ? {
          available: true,
          dir: TTS_RUNTIME_DIR,
          version: res.version ?? null,
          onnxruntime: res.onnxruntime ?? null,
        }
      : { available: false, dir: TTS_RUNTIME_DIR, error: String(res.error) };
  return probeCache;
}

/**
 * 用本地模型合成一段语音。
 *
 * @param {string} text - 要说的话。
 * @param {{modelRoot?: string, modelFile?: string, out?: string}} [options] -
 *   `modelRoot` 默认 `$DSH_HOME/tts/<bundle id>`。
 * @returns {Promise<object>} 成功时 `{ok:true, sampleRate, samples, durationMs, peak, wavBytes, out}`。
 */
export async function synthesize(text, options = {}) {
  const modelRoot = options.modelRoot ?? voiceModelPaths(voiceModelStoreRoot(), TTS_BUNDLE_ID).final;
  if (!existsSync(modelRoot)) {
    return { ok: false, error: `模型还没装：${modelRoot}` };
  }
  const out = options.out ?? join(mkdtempSync(join(tmpdir(), "herta-wav-")), "speech.wav");
  return runWorker(
    {
      runtimeDir: TTS_RUNTIME_DIR,
      mode: "synth",
      modelRoot,
      modelFile: options.modelFile ?? TTS_MODEL_FILE,
      text,
      out,
    },
    SYNTH_TIMEOUT_MS,
  );
}
