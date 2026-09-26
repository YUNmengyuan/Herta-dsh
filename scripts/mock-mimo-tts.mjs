/**
 * 假 MiMo TTS 服务 —— 与 mock-llm-server.mjs 同款思路：在没有真实 API Key
 * 的环境里验证整条链路（请求形状、鉴权头、WAV 回传、错误映射）。
 *
 * 它不碰任何真实凭据：MIMO_API_KEY 用一个假值指过来即可。
 *
 * 端点：POST /v1/chat/completions
 * 返回：OpenAI 兼容 JSON，choices[0].message.audio.data = base64 WAV。
 *
 * 按请求内容变化：
 *   · 文本含「拒绝」  → 401（验 refusal 分支）
 *   · 文本含「限额」  → 429 insufficient quota（验 quota 分支）
 *   · 文本含「超时」  → 挂住不回（验超时 → null 免声）
 *   · 其它            → 合成 0.3 秒 24 kHz 正弦波 WAV
 *
 * 用法：node scripts/mock-mimo-tts.mjs [--port 8793]
 */
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8793;

function makeWav(sampleRate, seconds) {
  const n = Math.floor(sampleRate * seconds);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

let callCount = 0;

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end("mock-mimo: only POST /v1/chat/completions");
    return;
  }
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    callCount += 1;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }

    const auth = req.headers.authorization ?? "";
    const voice = body?.audio?.voice ?? "";
    const text = body?.messages?.[0]?.content ?? "";

    console.log("[mock-mimo] #" + callCount + " model=" + body.model + " auth=" + auth.startsWith("Bearer ") + " voiceB64=" + voice.length + " text=" + text.slice(0, 40));

    if (text.includes("拒绝")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    if (text.includes("限额")) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "insufficient quota" } }));
      return;
    }
    if (text.includes("超时")) {
      // 故意挂住 —— 让调用方的 15s 超时触发
      return;
    }

    const wav = makeWav(24000, 0.3);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", audio: { data: wav.toString("base64") } } }],
      usage: { prompt_tokens: 5, completion_tokens: 12, total_tokens: 17 },
    }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[mock-mimo] 假 MiMo TTS 已就绪：http://127.0.0.1:" + PORT + "/v1/chat/completions");
  console.log("[mock-mimo] 文本含「拒绝」→401 / 含「限额」→429 / 含「超时」→挂住 / 其它→合成 0.3s WAV");
});
