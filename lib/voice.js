/**
 * 语音资产的静态路由。
 *
 * 80 条 `.opus`（2.5 MB）跟着包走：36 条开场白、12 类共 39 条语气词、
 * 4 条自我收回、1 条彩蛋。这一档**零依赖** —— 没有 TTS 运行时、没有 110 MB 模型，
 * 浏览器原生就能放 Ogg Opus。
 *
 * 安全：路径**只走白名单**。请求路径必须在启动时扫出来的索引里，
 * 否则一律 404。这样根本不存在路径穿越的可能，不需要再做规范化/校验。
 *
 * 这一块注册在**宿主面**（不是 preset 面）：静态资源与路由是进程级的一件事，
 * 挂一次就够，而且无头启动时没有 webServer。
 */
import { readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { registerDirRoute } from "./static-route.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 部署后布局是 `dsh-herta/lib/` 与 `dsh-herta/assets/` 同级。 */
const VOICE_DIR = join(HERE, "..", "assets", "voice");

/** 路由前缀。客户端按这个前缀取音频。 */
export const VOICE_ROUTE = "/herta-voice";

/** 一条语气词属于哪一类（particle 下按语气分目录）。 */
const PARTICLE_DIR = "particle";

/**
 * 扫出资产索引：`{ 类别: [相对路径, …] }`。
 * 启动时扫一次即可 —— 资产随包发布，运行期不会变。
 */
export function buildVoiceIndex() {
  const categories = {};
  let dirs;
  try {
    dirs = readdirSync(VOICE_DIR, { withFileTypes: true });
  } catch (error) {
    // 资产缺失不是致命错误：语音这一档整块退化为不可用，其余功能照常。
    if (error.code === "ENOENT") return categories;
    throw error;
  }

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const clips = [];
    // 相对路径**含类别前缀**（如 `particle/呵/001.opus`）—— 路由白名单与客户端
    // 都是按这个形态取文件的，漏掉前缀会导致白名单命中不了、全部 404。
    const walk = (dir, prefix) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          walk(full, `${prefix}/${item.name}`);
        } else if (extname(item.name) === ".opus") {
          clips.push(`${prefix}/${item.name}`);
        }
      }
    };
    walk(join(VOICE_DIR, entry.name), entry.name);
    if (clips.length > 0) categories[entry.name] = clips.sort();
  }
  return categories;
}

/** 语气词的全部类别名（particle 下的子目录）。 */
export function particleCategories(index) {
  const particles = index[PARTICLE_DIR] ?? [];
  return [...new Set(particles.map((clip) => clip.split("/")[1]).filter(Boolean))].sort();
}

/**
 * 注册语音路由。
 *
 * @param ctx - 宿主 cordis 上下文（需要 `webServer` 服务）。
 * @returns 路由的 disposer；没有 webServer 时返回 undefined（无头启动）。
 */
export function registerVoiceRoute(ctx) {
  const index = buildVoiceIndex();
  const total = Object.values(index).flatMap((list) => list).length;

  // 索引本身不是磁盘文件，用 synthetic 端点生成（见 static-route.js）。
  const disposer = registerDirRoute(ctx, {
    prefix: VOICE_ROUTE,
    dir: VOICE_DIR,
    synthetic: {
      "index.json": () => JSON.stringify({ categories: index, total }),
    },
  });

  if (disposer === undefined) {
    console.log(`[dsh-herta] 没有 webServer，语音路由跳过（索引里 ${total} 条）`);
    return undefined;
  }
  console.log(`[dsh-herta] 语音路由已挂：${VOICE_ROUTE}（${total} 条，${Object.keys(index).length} 类）`);
  return disposer;
}

/** 一条剪辑的完整 URL。逐段编码 —— 文件名里有中文与全角问号。 */
export function voiceUrl(rel) {
  return `${VOICE_ROUTE}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** 从数组里随机取一个。 */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** `auto` 时的落点权重：语气词最常见，开场白次之，彩蛋最稀有。 */
const AUTO_WEIGHTS = [
  { category: "particle", weight: 6 },
  { category: "openings", weight: 2 },
  { category: "veto", weight: 1 },
];

/**
 * 让黑塔发出一声。
 *
 * 工具本身**不放音频** —— 它做不到，宿主侧没有扬声器。它只负责挑一条剪辑，
 * 把结果经 `presentationMeta` 落到 `tool/result` 的 `meta` 上；
 * 浏览器侧的视图读到那条 tool-result 节点时再真正播放。
 *
 * 这条链路是 DSH 的既有机制（工具私有呈现负载走 `meta`），不需要新开通道。
 */
export const hertaSpeakTool = defineTool({
  name: "herta_speak",
  description:
    "让黑塔发出一声（她自己的录音片段，不是合成语音）。"
    + "可选类别：auto（让她自己挑，多半是一声语气词）、particle（语气词，呵/哼/嗯/哦…）、"
    + "openings（开场白独白）、veto（自我收回，用于「等等，我得再改一改」这类场合）、"
    + "easter_egg（唯一的彩蛋）。只在确实需要出声的时候用 —— 它是有声的表情，不是标点。",
  parameters: {
    category: {
      type: "string",
      description: "片段类别：auto | particle | openings | veto | easter_egg。默认 auto。",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: { type: "string", description: "实际选中的类别。" },
        clip: { type: "string", description: "片段在资产里的相对路径。" },
        url: { type: "string", description: "浏览器可直接取的 URL。" },
        note: { type: "string", description: "没有可用片段时的说明（正常情况下为空）。" },
      },
    },
    render: (_args, value) => [{ type: "text", text: `（${value.category} · ${value.clip}）` }],
    // 这一份才是浏览器真正用的：它落在 tool/result 的 meta 上。
    presentationMeta: (_args, value) => ({ hertaVoice: { category: value.category, clip: value.clip, url: value.url } }),
  },
  isConcurrencySafe: () => true,
  execute(args) {
    const index = buildVoiceIndex();
    const requested = typeof args.category === "string" && args.category !== "" ? args.category : "auto";

    let category = requested;
    if (requested === "auto") {
      const pool = AUTO_WEIGHTS.filter((w) => (index[w.category] ?? []).length > 0);
      const total = pool.reduce((n, w) => n + w.weight, 0);
      let roll = Math.random() * total;
      category = pool[pool.length - 1]?.category ?? "particle";
      for (const w of pool) {
        roll -= w.weight;
        if (roll <= 0) {
          category = w.category;
          break;
        }
      }
    }

    const list = index[category] ?? [];
    if (list.length === 0) {
      // 资产缺失或类别写错：不抛错，返回空结果让模型自己收场。
      const available = Object.keys(index).join(", ") || "（无资产）";
      return { category, clip: "", url: "", note: `这个类别没有片段；可用的类别：${available}` };
    }
    const clip = pick(list);
    return { category, clip, url: voiceUrl(clip) };
  },
});
