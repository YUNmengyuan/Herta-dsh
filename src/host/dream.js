/**
 * 做梦：把一份她自己写的废案**晋升**到记忆货架，并记进做梦账本。
 *
 * ## 与 Herta 原版的关系（重要，别误读）
 *
 * Herta 的 dream 是一个**离线自主**的 pass：切分会话 → 选片段 → 用它自己的
 * LLM 蒸馏出候选 → 语气复核 → 晋升或归档（`@herta/knowledge/dream`，约 6700 行）。
 *
 * 这里保留了两件真正有分量的东西：
 *   · **晋升门** —— 格式门（与读取端同一道）+ 标题新颖性 + 篇幅下限
 *   · **做梦账本** —— `<workspace>/.herta/dream/manifest.json`，
 *     逐条记 promoted/archived 与原因，与上游同构
 *
 * 换掉的是**蒸馏环节**：在 DSH 里模型就是她本人，会话上下文就在她眼前，
 * 再让宿主另起一次 LLM 调用去「蒸馏她自己」既昂贵又绕。所以由她在会话里
 * 写出候选，这个工具负责把关与落账。
 *
 * 也就是说：**「什么时候做梦」由她判断，「能不能记下来」由这道门判断。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { promoteFeian } from "./feian.js";
import { NARRATIVE_REL } from "./narrative.js";

/** 做梦账本的位置（与 Herta 本体的 `.herta/dream/manifest.json` 一致）。 */
export const DREAM_MANIFEST_REL = join(".herta", "dream", "manifest.json");

/** 一份「梦」的篇幅下限 —— 低于这个长度不是一段记忆，是一句备忘。 */
const MIN_DREAM_CHARS = 120;

function manifestPath(cwd) {
  return join(cwd, DREAM_MANIFEST_REL);
}

/**
 * 读做梦账本。不存在时返回空账本 —— 还没做过梦是正常状态，不是错误。
 * @param cwd - 会话工作区根。
 */
export async function readDreamManifest(cwd) {
  try {
    const raw = await readFile(manifestPath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      lastRunAt: parsed.lastRunAt ?? null,
      episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
      created: Array.isArray(parsed.created) ? parsed.created : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, lastRunAt: null, episodes: [], created: [] };
    // 账本坏了不该让做梦整个失败 —— 从空账本继续，坏文件留在原地可人工检查。
    if (error instanceof SyntaxError) return { version: 1, lastRunAt: null, episodes: [], created: [] };
    throw error;
  }
}

/**
 * 往账本追加一条 episode。写入是整份重写（账本很小，且要保证
 * `lastRunAt` 与 `episodes` 同一次落盘，不会出现只更新一半的状态）。
 */
async function appendDreamEpisode(cwd, episode, created) {
  const manifest = await readDreamManifest(cwd);
  const next = {
    version: manifest.version,
    lastRunAt: episode.at,
    episodes: [...manifest.episodes, episode],
    created: created === undefined ? manifest.created : [...manifest.created, created],
  };
  const path = manifestPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * 做梦。
 *
 * 输入是她写好的一份废案。工具做三件事：过晋升门 → 落盘或拒收 → 记账。
 * **拒收不抛错**：返回原因让她改一版重试，这正是她真实账本里
 * 「invalid after refine: bad header」那些条目的形态。
 */
export const hertaDreamTool = defineTool({
  name: "herta_dream",
  description:
    "把一段经历沉淀成一份废案，写进黑塔的记忆货架（做梦）。"
    + "用它，而不是随手记事：这里的门槛更高（格式、标题不重复、篇幅下限），"
    + "而且每一条都会记进做梦账本（promoted / archived 与原因）。"
    + "正文必须自带 `### 废案_NN：<标题>` 头（编号由工具分配，你只要给标题），"
    + "对话栅栏（（我 说）…（/我 说））必须成对闭合、不得嵌套。"
    + "被拒收时会告诉你原因，改一版再试即可。",
  parameters: {
    title: { type: "string", required: true, description: "这段记忆的标题。" },
    body: {
      type: "string",
      required: true,
      description: "正文，至少 120 字。可含（我 说）/（我 想）这类对话栅栏，必须成对闭合。",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        result: { type: "string", description: "promoted 或 archived。" },
        name: { type: "string", description: "晋升后的文件名（archived 时为空）。" },
        tokens: { type: "number", description: "晋升正文的估算 token。" },
        reason: { type: "string", description: "archived 的原因（promoted 时为空）。" },
        promoted: { type: "number", description: "账本里累计晋升条数。" },
        archived: { type: "number", description: "账本里累计归档条数。" },
      },
    },
    render: (args, value) =>
      value.result === "promoted"
        ? [
            {
              type: "text",
              text: `已晋升：${value.name}（约 ${value.tokens} token）。账本：累计晋升 ${value.promoted} 条、归档 ${value.archived} 条。`,
            },
          ]
        : [{ type: "text", text: `这次没有记下来（archived）：${value.reason}` }],
  },
  async execute(args, exec) {
    const cwd = exec.agent?.session.header.cwd;
    if (cwd === undefined) {
      throw new Error("dsh-herta: herta_dream 需要所属会话的工作区（session.header.cwd 缺失）");
    }
    const at = new Date().toISOString();
    const title = String(args.title ?? "").trim();
    const chars = String(args.body ?? "").trim().length;

    // 篇幅下限：一份「梦」应当是一段完整的记忆，不是一句备忘。
    // 备忘走 herta_memory_save，那条路径没有这道门槛。
    if (chars < MIN_DREAM_CHARS) {
      const episode = { at, result: "archived", title, reason: `too short (${chars} < ${MIN_DREAM_CHARS} chars)` };
      const next = await appendDreamEpisode(cwd, episode);
      return {
        result: "archived",
        name: "",
        tokens: 0,
        reason: episode.reason,
        promoted: next.episodes.filter((e) => e.result === "promoted").length,
        archived: next.episodes.filter((e) => e.result === "archived").length,
      };
    }

    const promoted = await promoteFeian(cwd, { title, body: args.body });
    const episode = promoted.saved
      ? { at, result: "promoted", title, file: promoted.name, tokens: promoted.tokens }
      : { at, result: "archived", title, reason: promoted.reason };

    const next = await appendDreamEpisode(
      cwd,
      episode,
      promoted.saved ? { title, file: promoted.name, state: "live" } : undefined,
    );

    return {
      result: promoted.saved ? "promoted" : "archived",
      name: promoted.saved ? promoted.name : "",
      tokens: promoted.saved ? promoted.tokens : 0,
      reason: promoted.saved ? "" : (promoted.reason ?? "未通过晋升门"),
      promoted: next.episodes.filter((e) => e.result === "promoted").length,
      archived: next.episodes.filter((e) => e.result === "archived").length,
    };
  },
});

/** 账本里晋升过的条数 —— 给列表工具与将来的界面用。 */
export async function dreamStats(cwd) {
  const m = await readDreamManifest(cwd);
  return {
    path: join(cwd, DREAM_MANIFEST_REL),
    lastRunAt: m.lastRunAt,
    promoted: m.episodes.filter((e) => e.result === "promoted").length,
    archived: m.episodes.filter((e) => e.result === "archived").length,
    episodes: m.episodes.length,
  };
}

/** 货架路径导出给测试用（避免测试里重复拼路径）。 */
export { NARRATIVE_REL };
