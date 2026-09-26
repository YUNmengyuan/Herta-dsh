/**
 * 本地 TTS 的**子进程**执行体（CommonJS）。
 *
 * ## 为什么必须是独立进程
 *
 * 三条理由，每条都是实打实踩过的：
 *
 * 1. **sherpa 的 espeak 构建在 Windows 上处理不了非 ASCII 的绝对路径**
 *    （上游 `tts-worker.cjs` 的原话）。而 DSH 的模型目录是
 *    `%USERPROFILE%\.dsh\tts\herta-best-e72` —— 用户名里有中文就中招。
 *    解法与上游一致：**把 cwd 设成模型根，传相对路径**。
 *    改 DSH 宿主进程的 cwd 会影响别的东西，所以只能放进子进程。
 * 2. **`generate()` 是同步阻塞的**：模型推理期间整个进程停住。
 *    放在宿主里就是把 DSH 卡死几十秒。
 * 3. **原生件在宿主里崩了就是宿主崩**。子进程死掉只丢一次合成。
 *
 * 用法（argv[2] 是一个 JSON 配置文件的路径，避免中文文本在命令行上被转义搞坏）：
 *
 *   node tts-worker.cjs <config.json>
 *
 * 配置：`{ runtimeDir, mode: "probe" | "synth", modelRoot?, modelFile?, text?, out? }`
 * 输出：stdout 上一行 JSON —— `{ ok: true, ... }` 或 `{ ok: false, error }`。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 把绝对路径转成「相对 cwd 的正斜杠形式」；不在 cwd 之下就原样返回。 */
function nativePath(file) {
  const rel = path.relative(process.cwd(), file);
  const selected = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
  return selected.split(path.sep).join("/");
}

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function loadSherpa(runtimeDir) {
  const entry = path.join(runtimeDir, "sherpa-onnx-node", "sherpa-onnx.js");
  if (!fs.existsSync(entry)) throw new Error(`找不到运行时入口：${entry}`);
  return require(entry);
}

/** 按上游 `tts-worker.cjs` 的 Kokoro 配置建实例（字段逐个照抄）。 */
function createTts(sherpa, modelRoot, modelFile) {
  const frontend = path.join(modelRoot, "frontend");
  return new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: nativePath(path.join(modelRoot, modelFile)),
        voices: nativePath(path.join(modelRoot, "voices.bin")),
        tokens: nativePath(path.join(frontend, "tokens.txt")),
        dataDir: nativePath(path.join(frontend, "espeak-ng-data")),
        lexicon: [
          nativePath(path.join(frontend, "lexicon-us-en.txt")),
          nativePath(path.join(frontend, "lexicon-zh.txt")),
        ].join(","),
      },
      debug: false,
      numThreads: Math.max(1, Math.min(4, os.availableParallelism())),
      provider: "cpu",
    },
    ruleFsts: ["phone-zh.fst", "date-zh.fst", "number-zh.fst"]
      .map((name) => nativePath(path.join(frontend, name)))
      .join(","),
    maxNumSentences: 1,
  });
}

function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 写一个 16-bit 单声道 WAV。 */
function writeWav(file, int16, sampleRate) {
  const dataBytes = int16.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(int16.buffer, int16.byteOffset, dataBytes).copy(buf, 44);
  fs.writeFileSync(file, buf);
}

function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const { runtimeDir, mode } = config;

  // probe：只证明「这个运行时能被加载」，不碰模型。
  if (mode === "probe") {
    const sherpa = loadSherpa(runtimeDir);
    reply({
      ok: true,
      mode: "probe",
      version: typeof sherpa.version === "string" ? sherpa.version : null,
      onnxruntime: typeof sherpa.onnxruntimeVersion === "string" ? sherpa.onnxruntimeVersion : null,
      hasOfflineTts: typeof sherpa.OfflineTts === "function",
    });
    return;
  }

  if (mode !== "synth") throw new Error(`未知 mode：${mode}`);

  const { modelRoot, modelFile, text, out } = config;
  // cwd 必须是模型根：上面 nativePath 的相对化全靠它。
  process.chdir(modelRoot);
  const sherpa = loadSherpa(runtimeDir);
  const tts = createTts(sherpa, process.cwd(), modelFile);

  const gc = new sherpa.GenerationConfig({
    sid: 0,
    speed: 1.0,
    // sherpa 默认 0.2 会把每处停顿砍掉（上游实测：5.0 s 的渲染里削掉 1.0 s 停顿，
    // 听感被判定为「明显变差」）。1.0 = 模型的原始输出。
    silenceScale: 1.0,
  });
  const audio = tts.generate({
    text,
    generationConfig: gc,
    // Electron 的 V8 拒收 EXTERNAL ArrayBuffer；普通 Node 也一并用这个更安全的开关。
    enableExternalBuffer: false,
  });

  const int16 = toInt16(audio.samples);
  writeWav(out, int16, audio.sampleRate);
  let peak = 0;
  let energy = 0;
  for (let i = 0; i < int16.length; i += 1) {
    const v = Math.abs(int16[i]);
    if (v > peak) peak = v;
    energy += v;
  }
  reply({
    ok: true,
    mode: "synth",
    sampleRate: audio.sampleRate,
    samples: int16.length,
    durationMs: (audio.samples.length / audio.sampleRate) * 1000,
    peak,
    meanAbs: int16.length === 0 ? 0 : energy / int16.length,
    wavBytes: 44 + int16.length * 2,
    out,
  });
}

try {
  main();
} catch (error) {
  reply({ ok: false, error: String(error && error.message ? error.message : error) });
  process.exitCode = 1;
}
