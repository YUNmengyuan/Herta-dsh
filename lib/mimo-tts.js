/**
 * MiMo 云端合成器 —— DSH 侧的 SpeechSynthesizer 实现（纯 JS，与 voice-settings-shared.js 同理）。
 *
 * 形状照抄上游 minimax-synthesizer.ts：一单元一 HTTP、失败/超时/取消 → null 免声、
 * available() 决定引擎是否可用、refusal 一次上报。接口按官方文档
 * https://mimo.mi.com/static/docs/api/audio/tts.md：
 * OpenAI 兼容的 /v1/chat/completions，mimo-v2.5-tts-voiceclone 模型，
 * audio.voice 传 base64 参考音频，audio.format 选 wav。
 *
 * 与 MiniMax 的关键差异：
 *   1. 参考音频用上游 herta-reference.wav（24 kHz 单声道 PCM，174 秒），
 *      不做 .opus → wav 转码（本机没有 ffmpeg，见交接 §5 坑 4）。
 *   2. MiMo 没有 adopt-before-clone 接口，每个请求都要带 base64 参考
 *      （按字节计费），缓存的是参考文件指纹而不是 voiceId。
 *   3. 一单元一请求，与 MiniMax 相同：失败/超时/取消一律 null，
 *      该单元按打字节奏显示而不发声。
 *
 * Key 从 MIMO_API_KEY 环境变量读（DSH credentials / .env），**不落**设置文档
 * （`dsh-herta` 那个 section 是用户可编辑的普通 JSON，明文密钥不该进去）。
 * base URL 从 MIMO_BASE_URL 读，默认官方端点。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** 官方默认端点（可被 MIMO_BASE_URL 覆盖）。 */
export const MIMO_DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";

/** voiceclone 模型（官方文档三选一，这里只用克隆那一个）。 */
export const MIMO_VOICECLONE_MODEL = "mimo-v2.5-tts-voiceclone";

/** 每单元的 HTTP 超时（与 MiniMax 的 DEFAULT_TIMEOUT_MS 一致）。 */
export const MIMO_UNIT_TIMEOUT_MS = 15_000;

/** 参考音频的上游位置（本机已验证存在）。 */
export const HERTA_REFERENCE_WAV = "D:\\Herta\\resources\\voice-clone\\herta-reference.wav";

/**
 * MiMo 的失败分类 —— 形状照抄 MiniMaxFailure，按 OpenAI 错误重映射。
 * @typedef {"no_key"|"invalid_key"|"auth"|"rate"|"quota"|"network"|"http"|"cancelled"|"reference"|"other"} MimoFailure
 */

/** MimoError 类。 */
export class MimoError extends Error {
  /**
   * @param {MimoFailure} reason
   * @param {string} message
   * @param {number} [statusCode]
   */
  constructor(reason, message, statusCode) {
    super(message);
    this.name = "MimoError";
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/**
 * fetch 的注入形状（与 minimax-api.ts 的 FetchLike 同构，便于测试替换）。
 * @typedef {(url: string, init: {method?: string, headers?: Record<string,string>, body?: string, signal?: AbortSignal}) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>} FetchLike
 */

/**
 * @typedef {{key: string|null, baseUrl: string}} MimoKeyRef
 */

/**
 * 读环境变量得到当前的 key/baseUrl（每次调用重新读，改 env 立即生效）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {MimoKeyRef}
 */
export function readMimoKeyFromEnv(env = process.env) {
  const key = env.MIMO_API_KEY ?? null;
  const baseUrl = (env.MIMO_BASE_URL ?? MIMO_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { key, baseUrl };
}

/**
 * 参考文件的指纹（SHA-256 前 16 hex）—— 用来缓存「这个参考已经验过可用」。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function referenceFingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * 读参考 WAV（不存在/读不了 → null，让 available() 如实报告不可用）。
 * @param {string} [path]
 * @returns {Uint8Array|null}
 */
export function readReferenceWav(path = HERTA_REFERENCE_WAV) {
  try {
    const buf = readFileSync(path);
    if (buf.length < 12) return null;
    if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
    if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * 把 OpenAI 风格的 HTTP 错误映射成 MimoFailure。
 * 官方文档没有公布错误码表，按通用 OpenAI 约定 + HTTP 状态映射；
 * 拿不准的一律 other —— 不猜具体原因比猜错要好。
 * @param {number} status
 * @param {string} body
 * @returns {MimoFailure}
 */
export function classifyMimoStatus(status, body) {
  const m = body.toLowerCase();
  if (status === 401) return "auth";
  if (status === 403) return "invalid_key";
  if (status === 429) return m.includes("quota") || m.includes("balance") ? "quota" : "rate";
  if (status >= 500) return "network";
  if (m.includes("api key") || m.includes("unauthorized")) return "invalid_key";
  if (m.includes("quota") || m.includes("balance")) return "quota";
  return "other";
}

/**
 * @typedef {{text: string, reference: Uint8Array, signal?: AbortSignal, sampleRate?: number}} MimoSynthesizeOptions
 */

/**
 * @typedef {{samples: Int16Array, sampleRate: number, billedChars: number}} MimoSynthesizedPcm
 */

/**
 * 一单元一 HTTP：POST /v1/chat/completions，拿 base64 音频。
 * 返回的 audio.data 是 base64 的 WAV（audio.format: "wav"），
 * 这里解析成 Int16 PCM —— 与上游 SynthesizedAudio 的形状对齐。
 * @param {FetchLike} fetchImpl
 * @param {MimoKeyRef} keyRef
 * @param {MimoSynthesizeOptions} opts
 * @returns {Promise<MimoSynthesizedPcm>}
 */
export async function synthesizePcm(fetchImpl, keyRef, opts) {
  const { key, baseUrl } = keyRef;
  if (key === null) throw new MimoError("no_key", "MIMO_API_KEY not set");

  const referenceB64 = Buffer.from(opts.reference).toString("base64");
  const body = JSON.stringify({
    model: MIMO_VOICECLONE_MODEL,
    messages: [{ role: "assistant", content: opts.text }],
    audio: { format: "wav", voice: referenceB64 },
    stream: false,
  });

  let res;
  try {
    res = await fetchImpl(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body,
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted === true) throw new MimoError("cancelled", "request aborted");
    throw new MimoError("network", err instanceof Error ? err.message : String(err));
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const reason = classifyMimoStatus(res.status, text);
    throw new MimoError(reason, "HTTP " + res.status + ": " + text.slice(0, 200), res.status);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MimoError("http", "non-JSON body");
  }

  const audioData = json?.choices?.[0]?.message?.audio?.data;
  if (typeof audioData !== "string" || audioData.length === 0) {
    throw new MimoError("other", "no audio.data in the response");
  }

  const wav = Buffer.from(audioData, "base64");
  const pcm = decodeWavToPcm16(wav);
  const billedChars = typeof json?.usage?.completion_tokens === "number"
    ? json.usage.completion_tokens
    : opts.text.length;

  return { samples: pcm.samples, sampleRate: pcm.sampleRate, billedChars };
}

/**
 * 极简 WAV 解析：RIFF....WAVE + fmt + data，只支持 PCM16 单声道。
 * 不做通用解码器 —— MiMo 返回的 audio.format: "wav" 就是这个形状。
 * @param {Uint8Array} buf
 * @returns {{samples: Int16Array, sampleRate: number}}
 */
export function decodeWavToPcm16(buf) {
  const b = Buffer.from(buf);
  if (b.length < 12) throw new MimoError("http", "wav too short");
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new MimoError("http", "not a RIFF/WAVE file");
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16) throw new MimoError("http", "fmt chunk too short");
      fmt = {
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = b.subarray(body, body + size);
    }
    pos = body + size + (size % 2);
  }
  if (fmt === null || data === null) throw new MimoError("http", "missing fmt or data chunk");
  if (fmt.channels !== 1) throw new MimoError("other", "expected mono, got " + fmt.channels + "ch");
  if (fmt.bitsPerSample !== 16) throw new MimoError("other", "expected 16-bit, got " + fmt.bitsPerSample + "-bit");

  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2);
  return { samples, sampleRate: fmt.sampleRate };
}

/**
 * @typedef {{utteranceId: string, seq: number, text: string, lang: "zh"|"en", priority?: "low"}} SynthesisReq
 */

/**
 * @typedef {{samples: Int16Array, sampleRate: number, durationMs: number}} SynthAudio
 */

/**
 * @typedef {object} MimoSynthesizerOpts
 * @property {FetchLike} fetch
 * @property {() => MimoKeyRef} keyRef
 * @property {() => boolean} enabled
 * @property {() => Uint8Array|null} reference
 * @property {(reason: MimoFailure|null) => void} [onRefusal]
 * @property {(line: string) => void} [log]
 * @property {number} [requestTimeoutMs]
 * @property {number} [maxInFlight]
 */

const REFUSALS = new Set(["auth", "invalid_key", "quota"]);
const MAX_DOOMED = 64;

/**
 * 创建 MiMo 合成器。
 * @param {MimoSynthesizerOpts} opts
 */
export function createMimoSynthesizer(opts) {
  const log = opts.log ?? ((l) => console.log("[herta-mimo] " + l));
  const timeoutMs = opts.requestTimeoutMs ?? MIMO_UNIT_TIMEOUT_MS;
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
  let disposed = false;
  let inFlight = 0;
  let lastFailure = null;
  let refusal = null;
  const doomed = new Set();
  const waiters = [];
  const controllers = new Map();

  const setRefusal = (next) => {
    const prev = refusal;
    refusal = next;
    if (prev !== next) opts.onRefusal?.(next);
  };

  const acquire = () => {
    if (inFlight < maxInFlight) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        inFlight += 1;
        resolve();
      });
    });
  };
  const release = () => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };

  const track = (utteranceId, ac) => {
    const set = controllers.get(utteranceId) ?? new Set();
    set.add(ac);
    controllers.set(utteranceId, set);
    return () => {
      set.delete(ac);
      if (set.size === 0) controllers.delete(utteranceId);
    };
  };

  return {
    available() {
      return !disposed && opts.enabled() && opts.keyRef().key !== null && opts.reference() !== null;
    },

    async synthesize(req) {
      if (disposed || !opts.enabled()) return null;
      const { key } = opts.keyRef();
      const reference = opts.reference();
      if (key === null || reference === null) return null;
      if (doomed.has(req.utteranceId)) return null;

      const ac = new AbortController();
      const untrack = track(req.utteranceId, ac);
      await acquire();
      if (ac.signal.aborted || disposed) {
        release();
        untrack();
        return null;
      }
      const timer = setTimeout(() => {
        ac.abort(new DOMException("timeout", "AbortError"));
      }, timeoutMs);
      try {
        const out = await synthesizePcm(opts.fetch, opts.keyRef(), {
          text: req.text,
          reference,
          signal: ac.signal,
        });
        lastFailure = null;
        setRefusal(null);
        return {
          samples: out.samples,
          sampleRate: out.sampleRate,
          durationMs: (out.samples.length / out.sampleRate) * 1000,
        };
      } catch (err) {
        if (err instanceof MimoError) {
          if (err.reason === "cancelled") return null;
          lastFailure = err.reason;
          if (REFUSALS.has(err.reason)) {
            doomed.add(req.utteranceId);
            if (doomed.size > MAX_DOOMED) {
              const oldest = doomed.values().next().value;
              if (oldest !== undefined) doomed.delete(oldest);
            }
            log("unit " + req.seq + " refused (" + err.reason + "): " + err.message);
            setRefusal(err.reason);
          } else {
            log("unit " + req.seq + " failed (" + err.reason + "): " + err.message);
          }
        } else {
          lastFailure = "other";
          log("unit " + req.seq + " failed: " + (err instanceof Error ? err.message : String(err)));
        }
        return null;
      } finally {
        clearTimeout(timer);
        release();
        untrack();
      }
    },

    cancel(utteranceId) {
      const set = controllers.get(utteranceId);
      if (set === undefined) return;
      for (const ac of set) ac.abort(new DOMException("cancelled", "AbortError"));
    },

    cancelAll() {
      for (const set of controllers.values()) {
        for (const ac of set) ac.abort(new DOMException("cancelled", "AbortError"));
      }
      controllers.clear();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const set of controllers.values()) {
        for (const ac of set) ac.abort(new DOMException("disposed", "AbortError"));
      }
      controllers.clear();
    },

    status() {
      return {
        keySet: opts.keyRef().key !== null,
        referenceReady: opts.reference() !== null,
        inFlight,
        refusal,
        lastFailure,
      };
    },
  };
}
