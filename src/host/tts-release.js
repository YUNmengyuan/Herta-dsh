/**
 * 本地语音模型（离线 TTS）的**发布固定参数** —— 逐字取自 Herta 上游。
 *
 * ## 来源（不是我拼的，是上游钉死在代码里的）
 *
 *   · `Herta-src/packages/gui/src/main/tts/tts-release.ts` —— URL / 体积 / SHA-256
 *   · `Herta-src/packages/gui/src/main/tts/tts-path.ts`    —— bundle id / 模型文件 / 必需文件清单
 *
 * 上游那段注释说明了为什么这些数字要钉在代码里而不是信服务端：
 * 「A retrain is a new bundle id …, a new archive, new pins, and therefore an app
 * release: the download never trusts the host, only this file.」
 *
 * ## 关于再分发
 *
 * 本插件**不重打包也不转发**这个归档，只是按上游发布的地址去取 —— 与上游自己的
 * 下载路径完全一致。模型与运行时的授权见仓库 `THIRD-PARTY.md`。
 */

/** 这个版本说话用的 bundle（Stage 2 best checkpoint，epoch 72）。 */
export const TTS_BUNDLE_ID = "herta-best-e72";

/** 归档文件名：`<bundle id>.tar.gz`。 */
export const TTS_ARCHIVE_NAME = `${TTS_BUNDLE_ID}.tar.gz`;

/** 上游发布页上的归档地址（tag 也按 bundle id 命名，模型与 App 各自独立发版）。 */
export const TTS_ARCHIVE_URL = `https://github.com/PersonaCLI/Herta/releases/download/voice-${TTS_BUNDLE_ID}/${TTS_ARCHIVE_NAME}`;

/** 归档的**精确字节数** —— 多收一个字节就中止（下载中途被塞了东西的判据之一）。 */
export const TTS_ARCHIVE_BYTES = 76_255_506;

/** 归档的 SHA-256 —— 解包**之前**必须先对上它。这是本路径唯一的安全边界。 */
export const TTS_ARCHIVE_SHA256 =
  "ce993a6fab911e9a86328facc952120c21de54303652f648e96e9d14ee4f172e";

/** 解包后的总体积（110.5 MiB）：解压炸弹的上限，也是设置面板要显示的文案。 */
export const TTS_BUNDLE_BYTES = 115_897_197;

/**
 * 本地覆盖归档地址的开发用开关（本地起个 http 服务、或换 staging 主机）。
 * 上游把它 gate `!app.isPackaged`；这里没有那个概念，所以**只有显式设了这个
 * 环境变量才会生效**，且**哈希 pin 照旧适用** —— 地址可换，内容不能换。
 */
export const TTS_ARCHIVE_URL_ENV = "HERTA_TTS_ARCHIVE_URL";

/** 当前生效的归档参数（URL 可能被上面的环境变量覆盖，其余三项永远来自 pin）。 */
export function resolveArchive() {
  const override = process.env[TTS_ARCHIVE_URL_ENV];
  return {
    url: typeof override === "string" && override !== "" ? override : TTS_ARCHIVE_URL,
    sha256: TTS_ARCHIVE_SHA256,
    bytes: TTS_ARCHIVE_BYTES,
    unpackedBytes: TTS_BUNDLE_BYTES,
    overridden: typeof override === "string" && override !== "",
  };
}

/**
 * 这一版随包带的 INT8 图。上游留了两份
 * （`model.int8-81mb.onnx` 与 `model.int8-97mb.onnx`），在非 VNNI 的 CPU 上
 * 大的那份只快约 8%、听感没差别，所以上游选了小的一份 —— 这里跟它一致。
 */
export const TTS_MODEL_FILE = "model.int8-81mb.onnx";

/** 通信用的声音处理（她是在空间站终端上说话）。 */
export const TTS_EFFECT = "terminal_textured";

/**
 * Kokoro 运行时真正会打开的文件。`frontend/dict/` 那棵 cppjieba 树**不在**其中
 * （上游用一次真实合成验过）。少一个就整档判不可用 —— 退化成纯文字推进，
 * 而不是让 worker 在初始化时崩掉。
 */
const REQUIRED_FILES = [
  TTS_MODEL_FILE,
  "voices.bin",
  "frontend/tokens.txt",
  "frontend/lexicon-us-en.txt",
  "frontend/lexicon-zh.txt",
  "frontend/phone-zh.fst",
  "frontend/date-zh.fst",
  "frontend/number-zh.fst",
];

export { REQUIRED_FILES };
