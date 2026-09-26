/**
 * dsh-herta 的 client（浏览器）半侧。
 *
 * 里程碑 3：把 DSH 的真实会话数据接进 Herta 的渲染组件。
 *
 * 数据来自官方扩展点，不是猜的：
 *   ctx.uiConversation.binding(sessionId)      → ConversationBinding
 *     .target('chat')                          → ObservableSnapshot<ChatSnapshot>
 *       .legacy.nodes                          → readonly ConversationNode[]
 *
 * `binding().target(id)` 是 `ConversationBinding` 的公开方法
 * （ui-conversation/src/client/conversation/assembly.ts:27-44）：第一个订阅者
 * 会激活该 target，之后它随会话生命周期常驻。所以我的视图可以在「对话」页签
 * 没被选中时也读到同一份组装结果。
 *
 * 组件拿数据的方式是 `inject` 返回的 `hooks` 隔间：里面每个 name 会被渲染器绑成
 * 一个 `use<Name>` 选择器钩子（ui-slots/src/renderer.ts:75-76），组件永远看不到
 * 订阅机制本身 —— 这是 DSH 客户端「业务组件不含订阅机器」那条硬规则。
 *
 * 样式仍然关在 shadow root 里，理由见 scripts/build.mjs 的 CSS 转换说明。
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HertaBubble } from "@gui/components/Workspace/HertaBubble";
import { UserBubble } from "@gui/components/Workspace/UserBubble";
import { LocaleProvider } from "@gui/i18n/LocaleProvider";
import hertaCss from "@gui/styles/reference-ux.css";
// 两个方向的映射都在共享模块里（纯函数，Node 里可直接单测：
// scripts/test-mapping.mjs）。客户端只负责订阅与渲染。
import { fullSnapshot, nodesToRecord, toBubbles } from "../shared/mapping.js";
// 语音偏好：默认值、归一化、iframe 要的 RealtimeVoiceState 都由这个纯模块给出
// —— 与宿主侧 `src/host/voice-settings.js` 共用同一份，而它无 import，
// 所以既能 Node 单测，也能被 esbuild 打进这份 bundle。
import {
  buildRealtimeVoiceState,
  emptyKeyStatus,
  isVoiceEngine,
  normalizeVoiceSettings,
} from "../host/voice-settings-shared.js";
// 设置字段表：与宿主**同一份**（无 import 的纯数据模块，esbuild 直接内联）。
// 页面的标签、枚举选项、默认值、以及「哪些字段属于哪份文件」全部从它读 ——
// 客户端不再自持第二份字段清单（那正是「设置页能选、写回时被判非法」的来源）。
import { FIELDS, normalizeSettings } from "../host/settings-schema.js";

/** Cordis 插件名，与 cordis.patch.yml 里的 loader 条目 id 一致。 */
const name = "herta";

/** 客户端服务：槽位注册表 + Conversation 组装。 */
const inject = ["uiConversation", "slots"];

/**
 * 视图 id：`conversation.view` 槽内的唯一键。
 * 壳会把用户选中的视图偏好按这个 id 持久化，所以改它等于换一个页签。
 */
const VIEW_ID = "herta";

/** 整机页签的视图 id（甲方案，iframe）。 */
const FULL_VIEW_ID = "herta-full";

/**
 * 设置命名空间 = 宿主那条 profile 条目的 id。
 *
 * 字面量，不 import 宿主模块：客户端包不得依赖宿主包（DSH 的
 * `packages/client/tsdown.client.ts` 纯净度门），官方四个伴生设置页也全都
 * 在客户端重写一遍这个常量。它与 `src/host/index.js` 的
 * `HERTA_SETTINGS_NAMESPACE` 必须是同一个字符串。
 */
const MACHINE_NS = "herta";

/** `ctx.configForms.get(ns)` 返回的那张表单（只列本文件用到的成员）。 */
interface MachineForm {
  getSnapshot(): {
    status: "loading" | "ready" | "unavailable";
    value?: Record<string, unknown>;
    user?: unknown;
    writable?: boolean;
  };
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
  mutate(ops: readonly unknown[]): Promise<boolean>;
}

/**
 * 当前绑定的设置表单。由 `apply` 里的 `ctx.inject(["configForms"], …)` 赋值 ——
 * 服务缺席（或命名空间还没被宿主服务）时保持 null，所有读取退到默认值，
 * 所有写入变成无害的空操作。**不报错、不白屏**是这里唯一的设计要求。
 */
let machineForm: MachineForm | null = null;

/** 设置值快照（永远完整：非法/缺失一律回落默认），供 iframe 的应答器同步读。 */
function machineValues(): Record<string, unknown> {
  return normalizeSettings(machineForm?.getSnapshot().value);
}

/**
 * 当前被声明「跟随整机」的字段名单。
 *
 * 这份名单由客户端写进 Config 的 `followedFields`（宿主侧读它以跳过种子），
 * 不是页面上的字段 —— 见 `src/host/index.js` 里该字段的注释。
 */
function followedFields(): string[] {
  const raw = machineForm?.getSnapshot().value?.followedFields;
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
}

/** 一趟原子写入：一次 revision 栅栏、一次失败重读。 */
async function writeMachineOps(ops: readonly Record<string, unknown>[]): Promise<boolean> {
  const field = String((ops[0]?.path as readonly string[] | undefined)?.[0] ?? "");
  if (machineForm === null) {
    markMachine("settingsWriteSkipped", field);
    return false;
  }
  try {
    const accepted = await machineForm.mutate(ops);
    markMachine("settingsLastWrite", field);
    markMachine("settingsLastWriteAccepted", accepted);
    return accepted;
  } catch (error) {
    markMachine("settingsWriteError", String((error as Error)?.message ?? error));
    return false;
  }
}

/** 写一个设置字段。顺带把它从「跟随整机」名单里摘掉 —— 用户接手了。 */
async function writeMachineField(field: string, value: unknown): Promise<boolean> {
  const followed = followedFields();
  const ops: Record<string, unknown>[] = [{ op: "set", path: [field], value }];
  if (followed.includes(field)) {
    ops.push({ op: "set", path: ["followedFields"], value: followed.filter((name) => name !== field) });
  }
  return writeMachineOps(ops);
}

/**
 * 声明「这一项跟随整机」：清掉 DSH 的覆盖，并把它记进 `followedFields`。
 *
 * **只 unset 是不够的**：下一轮种子会把整机那边的值再搬进来，覆盖立刻"复活"，
 * 按钮看起来毫无作用。名单才是那条声明的载体。
 */
async function followMachineField(field: string): Promise<boolean> {
  const next = [...new Set([...followedFields(), field])];
  return writeMachineOps([
    { op: "unset", path: [field] },
    { op: "set", path: ["followedFields"], value: next },
  ]);
}

/** 记一条设置相关的诊断，便于从无头浏览器外部确认「到底写没写」。 */
function markMachine(field: string, value: unknown): void {
  const mark = (globalThis as Record<string, unknown>).__DSH_HERTA__ as
    | Record<string, unknown>
    | undefined;
  if (mark !== undefined) mark[field] = value;
}

/**
 * 语音偏好的读写口 —— iframe 那边 12 个应答器都读它。
 *
 * **对外形状刻意保持不变**（`{getSnapshot().value, set(field, value)}`）：整机
 * iframe 的 `VoiceSettings` 组件从上一版起就按这个形状调用，形状一改，
 * 面板会静默显示默认值。
 *
 * 0.1.7-rc.2 起背后是 DSH 的设置表单（`ctx.configForms.get("herta")`）：
 * 同一个命名空间既喂这张面板、也喂 DSH 自己设置页里的「黑塔」一页，
 * 而且写入会落进 profile 的 `cordis.patch.yml`。上一版走的是插件自持的
 * HTTP 端点（`/herta-settings`）—— 那是 settingsScope 被移除后的临时替代，
 * 现在有正式入口了就把那条路拆了（少一个真相来源）。
 */
const voiceScope = {
  getSnapshot(): { value?: unknown } {
    const values = machineValues();
    return { value: { engine: values.voiceEngine, realtimeVoice: values.realtimeVoice } };
  },
  async set(field: string, value: unknown): Promise<void> {
    // 字段名在这里翻译一次：bridge 的契约叫 `engine`，DSH 的字段叫 `voiceEngine`。
    const name = field === "engine" ? "voiceEngine" : field;
    await writeMachineField(name, value);
  },
};

/**
 * 本地语音模型（离线 TTS）状态 —— 宿主 `/herta-voice-model` 的镜像。
 *
 * 为什么要有本地镜像 + 轮询，而不是每次现问：
 *   · 整机 iframe 的 `getRealtimeVoice` 是**同步应答**的（它读 `RealtimeVoiceState`
 *     里的 `model` 字段），不能在里面 await 一次 HTTP
 *   · 下载要显示进度，而进度只能靠轮询拿（宿主是 GET 状态 / POST 动作的形态）
 *
 * 轮询**只在 `downloading` 时开**：平时一个定时器都不留，下载一结束就清掉。
 */
const VOICE_MODEL_URL = "/herta-voice-model";

/** 当前状态；null = 还没问过宿主。 */
let voiceModelState: Record<string, unknown> | null = null;

/** 订阅者（由整机视图的 `onVoiceModel` 挂上）。 */
const voiceModelSubs = new Set<(state: unknown) => void>();

let voiceModelTimer: ReturnType<typeof setInterval> | null = null;

function notifyVoiceModel(): void {
  for (const cb of voiceModelSubs) {
    try {
      cb(voiceModelState);
    } catch {
      /* 一个订阅者坏掉不该影响别的 */
    }
  }
}

/** 按当前阶段开关轮询：只有下载中才需要密集问。 */
function syncVoiceModelTimer(): void {
  const phase = voiceModelState?.phase;
  if (phase === "downloading" && voiceModelTimer === null) {
    voiceModelTimer = setInterval(() => {
      void refreshVoiceModel();
    }, 500);
  } else if (phase !== "downloading" && voiceModelTimer !== null) {
    clearInterval(voiceModelTimer);
    voiceModelTimer = null;
  }
}

/** 拉一次宿主状态；失败保留上一次（不把界面打回默认值）。 */
async function refreshVoiceModel(): Promise<unknown> {
  try {
    const res = await fetch(VOICE_MODEL_URL, { headers: { accept: "application/json" } });
    if (res.ok) {
      voiceModelState = (await res.json()) as Record<string, unknown>;
    }
  } catch {
    /* 拿不到就沿用上一次 */
  }
  syncVoiceModelTimer();
  notifyVoiceModel();
  return voiceModelState;
}

/** 发一个动作（download / cancel / remove），返回宿主回的状态。 */
async function postVoiceModel(action: string): Promise<unknown> {
  try {
    const res = await fetch(VOICE_MODEL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) voiceModelState = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 动作发不出去：状态不变，下面的 refresh 会把它拉回真相 */
  }
  await refreshVoiceModel();
  return voiceModelState;
}

/** 把模型状态拼成 `buildRealtimeVoiceState` 要的宿主事实。 */
function voiceModelFacts(): Record<string, unknown> {
  const phase = typeof voiceModelState?.phase === "string" ? voiceModelState.phase : "absent";
  // 运行时来自宿主对 `assets/tts-runtime` 的**真探测**（子进程加载 addon），
  // 不是常量。探测没成功（或还没问到）就是 false —— 设置面板把「下载模型」
  // 按钮与「实时语音」开关都 gate 在它上面，写死 true 就是假绿。
  const runtime = voiceModelState?.runtime as { available?: boolean } | undefined;
  return {
    runtime: runtime?.available === true,
    // 「bundle 在不在」＝ 模型装好了没有。
    bundle: phase === "ready",
    failed: phase === "failed",
    model: {
      phase,
      receivedBytes: voiceModelState?.receivedBytes,
      totalBytes: voiceModelState?.totalBytes,
      unpackedBytes: voiceModelState?.unpackedBytes,
    },
  };
}

/** 一个待渲染的气泡，已经从 DSH 节点降维成 Herta 组件认识的两要素。 */
interface Bubble {
  readonly role: "user" | "herta";
  readonly text: string;
  readonly at?: string;
}

/** 降维时被丢掉、Herta 的模型里没有对应物的节点计数。 */
interface Dropped {
  readonly total: number;
  readonly kinds: readonly string[];
}

/** 一条来自 `herta_speak` 工具结果的发声指令。 */
interface VoiceCue {
  readonly seq: number;
  readonly url: string;
  readonly clip: string;
  readonly category: string;
}

/** 从 DSH 的 ContentBlock[] 里取纯文本；图片/文件/工具块这一版先不处理。 */
/** DSH 把生效主题写在 documentElement 的 inline colorScheme 上（ui-theme/boot-theme.ts:19）。 */
function currentDshTheme(): "dark" | "light" {
  return document.documentElement.style.colorScheme === "dark" ? "dark" : "light";
}

/**
 * 准备 shadow root：样式表只注入一次，挂载点复用。
 * 用 shadow 是为了让 279 KB 的 Herta 全局样式表既生效又外溢不出去。
 */
function ensureShadowMount(host: HTMLElement): HTMLElement {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  if (shadow.querySelector("style[data-herta]") === null) {
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.setAttribute("data-herta", "");
    style.textContent = hertaCss;
    shadow.append(style);
  }
  const existing = shadow.querySelector("[data-herta-mount]");
  if (existing instanceof HTMLElement) return existing;
  const mount = document.createElement("div");
  mount.setAttribute("data-herta-mount", "");
  shadow.append(mount);
  return mount;
}

/** 把所有气泡渲染成 Herta 的组件树。 */
function renderBubbleList(bubbles: readonly Bubble[]): unknown {
  const children = bubbles.map((b, i) =>
    b.role === "user"
      ? createElement(UserBubble, {
          key: `${i}-user`,
          text: b.text,
          ...(b.at === undefined ? {} : { at: b.at }),
        })
      : createElement(HertaBubble, {
          key: `${i}-herta`,
          text: b.text,
          lang: "zh",
          ...(b.at === undefined ? {} : { at: b.at }),
        }),
  );
  return createElement("div", null, children);
}

// ── 语音（C 层）──────────────────────────────────────────────────────────────
// 80 条 .opus 由宿主侧的静态路由 `/herta-voice` 提供（见 src/host/voice.js）。
// 这一档零依赖：浏览器原生就能放 Ogg Opus，没有 TTS 运行时、没有模型。

/** 语音索引：`{ 类别: [相对路径, …] }`，启动时由宿主扫出来。 */
type VoiceIndex = Record<string, readonly string[]>;

/** 一条剪辑的完整 URL。路径里可能有中文与特殊字符，逐段编码。 */
function clipUrl(rel) {
  return `/herta-voice/${String(rel).split("/").map(encodeURIComponent).join("/")}`;
}

/** 记一条诊断信息，便于从无头浏览器外部确认「到底放没放」。 */
function markVoice(field, value) {
  const mark = globalThis.__DSH_HERTA__;
  if (mark !== undefined) mark[field] = value;
}

/**
 * 播放一个 URL。
 *
 * 自动播放可能被浏览器策略拦下（没有用户手势时），这里**吞掉失败** ——
 * 静音降级是合理的，不该因此报错或中断界面。播放事实记进诊断标记，
 * 所以从外部仍然能确认「到底放没放」。
 */
function playUrl(url: string): void {
  try {
    const audio = new Audio(url);
    audio.volume = 0.9;
    const p = audio.play();
    if (p !== undefined) p.catch(() => {});
    markVoice("lastVoiceUrl", url);
    markVoice("voicePlays", (globalThis.__DSH_HERTA__?.voicePlays ?? 0) + 1);
  } catch {
    markVoice("lastVoiceError", url);
  }
}

/** 播放资产里的一条剪辑（传相对路径）。 */
function playClip(rel) {
  playUrl(clipUrl(rel));
}

/** 从数组里随机取一个。 */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 黑塔面板：语音条 + 气泡列表。
 *
 * 语音状态（索引、静音）由这个组件持有 —— 它挂在 shadow 里的嵌套 root 上，
 * 所以 hooks 照常可用。数据仍由外层通过 props 传入，组件本身不订阅会话。
 */
function HertaPanel(props: { bubbles: readonly Bubble[]; voiceCues: readonly VoiceCue[] }): unknown {
  const [index, setIndex] = useState(null);
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState("");
  const [autoVoice, setAutoVoice] = useState(true);

  // 索引只取一次。
  useEffect(() => {
    let alive = true;
    fetch("/herta-voice/index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive) setIndex(data?.categories ?? null);
      })
      .catch(() => {
        if (alive) setIndex(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const hertaBubbles = props.bubbles.filter((b) => b.role === "herta").length;

  const playParticle = useCallback(() => {
    if (index === null) return;
    const particles = index.particle ?? [];
    if (particles.length === 0) return;
    playClip(pick(particles));
    setNotice(`语气：${pick(particles).split("/")[1]}`);
  }, [index]);

  // 她的新气泡出现时自动配一声语气词。首帧不响（挂载时不该突然出声）。
  const seen = useRef(0);
  useEffect(() => {
    if (!muted && autoVoice && index !== null && hertaBubbles > seen.current && seen.current > 0) {
      playParticle();
    }
    seen.current = hertaBubbles;
  }, [hertaBubbles, muted, autoVoice, index, playParticle]);

  // 模型主动发声：`herta_speak` 的工具结果带一条指令，这里按 seq 去重后播放。
  // 用 Set 去重是必须的 —— 视图每次重渲都会重新走一遍全部节点，
  // 不记已播过的 seq 就会把历史里每一声都重放一遍。
  const playedSeqs = useRef(new Set());
  useEffect(() => {
    if (muted) return;
    for (const cue of props.voiceCues) {
      if (playedSeqs.current.has(cue.seq)) continue;
      playedSeqs.current.add(cue.seq);
      playUrl(cue.url);
      setNotice(`她说（${cue.category}）`);
    }
  }, [props.voiceCues, muted]);

  const total = index === null ? 0 : Object.values(index).reduce((n, l) => n + l.length, 0);

  const button = (label, onClick, key) =>
    createElement(
      "button",
      {
        key,
        type: "button",
        onClick,
        style: {
          font: "inherit",
          padding: "4px 10px",
          borderRadius: "6px",
          border: "1px solid currentColor",
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          opacity: muted ? 0.5 : 1,
        },
      },
      label,
    );

  const bar = createElement(
    "div",
    {
      style: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
        flexWrap: "wrap",
        padding: "8px 16px",
        opacity: 0.85,
      },
    },
    [
      button("开场", () => {
        const openings = index?.openings ?? [];
        if (openings.length > 0) {
          playClip(pick(openings));
          setNotice("开场白");
        }
      }, "open"),
      button("语气", playParticle, "particle"),
      button(muted ? "🔇 已静音" : "🔊 有声", () => {
        setMuted((m) => !m);
        setNotice("");
      }, "mute"),
      button(autoVoice ? "自动配音：开" : "自动配音：关", () => setAutoVoice((v) => !v), "auto"),
      createElement(
        "span",
        { key: "info", style: { fontSize: "12px", opacity: 0.7 } },
        index === null
          ? "语音资产不可用"
          : `语音资产 ${total} 条${notice === "" ? "" : ` · ${notice}`}`,
      ),
    ],
  );

  return createElement("div", { style: { padding: "8px 0 16px" } }, [
    bar,
    createElement("div", { key: "bubbles", style: { padding: "0 16px" } }, renderBubbleList(props.bubbles)),
  ]);
}

/** 空节点列表的稳定引用，避免每次渲染都造新数组去刷新 useMemo。 */
const NO_NODES: readonly unknown[] = [];

/**
 * 黑塔会话视图。
 *
 * 数据经 `props.useHertaChat(...)` 到达 —— 由 `inject` 的 `hooks` 隔间绑定的
 * 选择器钩子。组件本身不做任何订阅。
 *
 * 注意必须传选择器：这个钩子是 ui-renderer 的 `bindSnapshotSelector` 产的
 * （bind.ts:21-26），签名是 `(sel, eq?)`，运行时**没有**默认选择器 ——
 * 不传就会在 uSES 内部炸 `l is not a function`。恒等选择器即可拿到原快照。
 */
function HertaView(props: {
  useHertaChat?: (
    sel: (s: unknown) => unknown,
  ) => { legacy?: { nodes?: readonly unknown[] } } | undefined;
}): unknown {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<{ host: HTMLElement; root: Root } | null>(null);

  const chat =
    typeof props.useHertaChat === "function"
      ? (props.useHertaChat((s) => s) as
          | { legacy?: { nodes?: readonly unknown[] } }
          | undefined)
      : undefined;
  const nodes = chat?.legacy?.nodes ?? NO_NODES;
  const { bubbles, dropped, voiceCues } = useMemo(() => toBubbles(nodes), [nodes]);

  // 卸载时释放嵌套 root（shadow root 本身跨挂载存活，所以这里只收 root）。
  useEffect(
    () => () => {
      rootRef.current?.root.unmount();
      rootRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const mount = ensureShadowMount(host);
    if (rootRef.current === null || rootRef.current.host !== host) {
      rootRef.current = { host, root: createRoot(mount) };
    }
    const theme = currentDshTheme();
    // 主题要挂在 shadow **host** 上（也就是 hostRef 那个 div），
    // Herta 的暗色规则是 :host([data-theme="dark"])。
    // 注意不能用 mount.parentElement —— 那是 ShadowRoot，属于 DocumentFragment，
    // 根本没有 setAttribute。
    if (theme === "dark") host.setAttribute("data-theme", "dark");
    else host.removeAttribute("data-theme");
    rootRef.current.root.render(
      createElement(
        LocaleProvider,
        { locale: "zh", onLocaleChange: () => {} },
        // HertaPanel 的位置与类型都稳定，所以外层每次重渲只会更新 props，
        // 面板自己的语音状态（索引/静音/已播 seq）不会被重置。
        createElement(HertaPanel, { bubbles, voiceCues }),
      ),
    );

    const mark = (globalThis as Record<string, unknown>).__DSH_HERTA__ as
      | Record<string, unknown>
      | undefined;
    if (mark !== undefined) {
      mark.viewMounted = true;
      mark.theme = theme;
      mark.cssWhere = host.shadowRoot !== null ? "shadow" : "none";
      mark.bubbles = bubbles.length;
      mark.droppedNodes = dropped.total;
      mark.droppedKinds = [...new Set(dropped.kinds)];
    }
  }, [bubbles, dropped]);

  return createElement("div", { ref: hostRef, "data-dsh-herta-view": "ready" });
}

/**
 * DSH 会话节点 → 她的 `TerminalRecord`（甲的数据映射，乙映射的反方向）。
 *
 * 她的记录只有三种块：`user` / `herta`（surface 分 speech|thought）/ `system`。
 * 映射规则与乙那边保持一致，只是方向相反：
 *
 * | DSH 节点 | 她的块 |
 * |---|---|
 * | `user` / `steering` | `user` |
 * | `assistant`（text 块） | `herta{surface:'speech'}` |
 * | `assistant`（reasoning 块） | **丢弃** —— 她的 `thought` surface 本来就不渲染 |
 * | `tool-result` | `system{label:'系统', body:工具摘要}` |
 * | `turn-error` | `system{label:'系统', body:错误}` |
 * | context / command / compaction | `system` 或丢弃（她的模型里没有对应物） |
 */
/**
 * 「黑塔·整机」视图（甲方案）。
 *
 * 与「黑塔」页签（乙）的分工：
 *   · 乙 = 用她的**展示组件**渲染 DSH 的会话 —— 「她在 DSH 里干活」
 *   · 甲 = 用 iframe 装下她的**整个世界**（侧栏 / 开场 / 设备卡 / 她自己的会话）
 *
 * 用 iframe 而不是把整机组件塞进槽里，有三个实打实的理由：
 *   1. **样式**：整机用的是她原版的整页样式（`:root` / `body` 整页规则），
 *      塞进宿主的 slot 必然打架；iframe 天然是独立文档。
 *   2. **隔离**：整机是 16 MB 的应用，它崩了不该拖垮 DSH 界面。
 *   3. **它本来就是按窗口写的**：固定定位、vw/vh、按视口测量 —— 上游官网
 *      也是因此把 demo 放进 iframe 的。
 *
 * 数据流：这个组件用 `useHertaChat` 订阅会话，把节点映射成她的记录后用
 * postMessage 推给 iframe；iframe 里的 bridge 发过来的调用也在这里回答。
 */
function HertaFullView(props: {
  sessionId?: string;
  useHertaChat?: (
    sel: (s: unknown) => unknown,
  ) => { legacy?: { nodes?: readonly unknown[]; partial?: unknown } } | undefined;
}): unknown {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const chat =
    typeof props.useHertaChat === "function"
      ? (props.useHertaChat((s) => s) as
          | { legacy?: { nodes?: readonly unknown[]; partial?: unknown } }
          | undefined)
      : undefined;
  const nodes = chat?.legacy?.nodes ?? NO_NODES;
  const record = useMemo(() => nodesToRecord(nodes), [nodes]);
  const title = useMemo(() => null, []);

  // 最新一帧的数据放在 ref 里 —— 应答 iframe 的调用时需要同步读到它，
  // 而事件监听器只挂一次，闭包捕获不到后续的新值。
  const latest = useRef({ record, nodes, sessionId: props.sessionId, title });
  latest.current = { record, nodes, sessionId: props.sessionId, title };

  /** 往 iframe 推一条消息。iframe 还没加载完时静默丢弃。 */
  const push = (event: string, payload: unknown) => {
    const win = frameRef.current?.contentWindow;
    if (win === null || win === undefined) return;
    win.postMessage({ __herta: true, kind: "event", event, payload }, window.location.origin);
  };

  // 数据变了就整份推送（她的 store 走 replace 路径）。
  useEffect(() => {
    const { record: r, nodes: n, sessionId, title: t } = latest.current;
    if (r.length === 0 && n.length === 0) {
      // 空会话：推「没有会话」，让渲染层走它自己的未连接分支而不是空转。
      push("reset", { noSession: true });
      return;
    }
    push("reset", fullSnapshot(sessionId, r));
    const mark = globalThis.__DSH_HERTA__;
    if (mark !== undefined) {
      mark.fullViewPushed = (mark.fullViewPushed ?? 0) + 1;
      mark.fullViewBlocks = r.length;
    }
  }, [record, nodes, props.sessionId]);

  // 离线模型状态：**父窗口主动推一次**。
  // iframe 那边的 `onVoiceModel` 本来只登记本地监听，订阅时才补一个 call 过来；
  // 而那台设置面板是先 `getRealtimeVoice()` 再订阅 —— 父窗口不主动推的话，
  // 首次读到的 `model.unpackedBytes` 是 0，面板就显示「约 0 MB」而不是真实体积。
  useEffect(() => {
    let alive = true;
    void refreshVoiceModel().then((s) => {
      if (!alive) return;
      push("voiceModel", s);
      const mark = globalThis.__DSH_HERTA__;
      if (mark !== undefined) {
        mark.voiceModelPushed = true;
        mark.voiceModelPhase = (s as { phase?: string } | null)?.phase ?? null;
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // 应答 iframe 的调用。
  useEffect(() => {
    const reply = (id: number, value: unknown) =>
      frameRef.current?.contentWindow?.postMessage(
        { __herta: true, kind: "reply", id, value },
        window.location.origin,
      );
    const fail = (id: number, error: string) =>
      frameRef.current?.contentWindow?.postMessage(
        { __herta: true, kind: "reply", id, error },
        window.location.origin,
      );

    const onMessage = (event: MessageEvent) => {
      const msg = event.data as {
        __herta?: boolean;
        kind?: string;
        id?: number;
        method?: string;
        params?: unknown;
      };
      if (msg === null || typeof msg !== "object" || msg.__herta !== true) return;

      if (msg.kind === "hello") {
        const { record: r, nodes: n, sessionId, title: t } = latest.current;
        push("reset", r.length === 0 && n.length === 0 ? { noSession: true } : fullSnapshot(sessionId, r));
        const mark = globalThis.__DSH_HERTA__;
        if (mark !== undefined) mark.fullViewBooted = true;
        return;
      }
      if (msg.kind !== "call" || typeof msg.id !== "number") return;

      switch (msg.method) {
        // ── 设置（全部读写同一个设置命名空间）────────────────────────────
        //
        // **以前这几个是坏的**：`getLocale` / `getCloseToTray` / `getDreamConfig`
        // 返回硬编码常量，三个 setter 根本没进 switch（落到 default 的
        // 「还没有实现」分支）。也就是她的设置面板能点、点了不报错、值却永远不变 ——
        // 典型假绿。现在统一读写 `ctx.configForms.get("herta")`，
        // 与 DSH 设置页里的「黑塔」一页是同一份值、同一条写入路径。
        case "getLocale": {
          // bridge 的 `getLocale` 要一个真语言（`"zh" | "en"`），而设置里的
          // `locale` 允许空串 = 跟随系统。空串在这里按系统语言解析。
          const locale = machineValues().locale;
          if (typeof locale === "string" && locale !== "") return reply(msg.id, locale);
          return reply(msg.id, navigator.language?.startsWith("zh") === true ? "zh" : "en");
        }
        case "setLocale": {
          const next = (msg.params as { locale?: unknown } | undefined)?.locale;
          if (next === "zh" || next === "en") void writeMachineField("locale", next);
          return reply(msg.id, undefined);
        }
        case "getTheme":
          return reply(msg.id, currentDshTheme());
        case "getCloseToTray":
          return reply(msg.id, machineValues().closeToTray);
        case "setCloseToTray": {
          const next = (msg.params as { enabled?: unknown } | undefined)?.enabled;
          if (typeof next === "boolean") void writeMachineField("closeToTray", next);
          return reply(msg.id, undefined);
        }
        case "getDreamConfig":
          return reply(msg.id, { enabled: machineValues().dreamEnabled });
        case "setDreamConfig": {
          const next = (msg.params as { cfg?: { enabled?: unknown } } | undefined)?.cfg?.enabled;
          if (typeof next === "boolean") void writeMachineField("dreamEnabled", next);
          return reply(msg.id, undefined);
        }
        case "getDeepSeekKeyStatus":
          return reply(msg.id, { set: true, hint: "dsh", encrypted: true });
        case "listSessions":
          // 整机视图目前只服务「当前这一个 DSH 会话」，所以她自己的会话列表是空的。
          return reply(msg.id, []);
        case "maybePlayEasterEgg":
          return reply(msg.id, undefined);
        // ── 语音（VoiceSettings 的 12 个应答器，见 Herta-语音模块-交接.md §2.2）──
        // 上游 bridge 契约里这些方法原本全部缺失，整块静默失败（能选但不生效）。
        //
        // **引擎与开关现在是真的**：来自 DSH 设置命名空间 `herta` 的两个字段
        // （`voiceEngine` / `realtimeVoice`），也就是 DSH 设置页里「黑塔」那一页
        // 改的是同一份值。写入落进 profile 的 `cordis.patch.yml`，并由宿主侧
        // 同步进整机自己的 `settings.json`。
        //
        // 其余字段是**宿主事实**（模型在不在、密钥设没设）。三个引擎现在都还没
        // 接线（第三步离线引擎、第四步触发点），所以如实报告「不可用」——
        // 这修掉了上一版硬编码 `bundle: true, runtime: true` 的假绿：
        // 那会让设置面板把离线引擎显示成「已就绪」，而 DSH 一个音都合成不出来。
        case "getRealtimeVoice":
          return reply(
            msg.id,
            buildRealtimeVoiceState(
              normalizeVoiceSettings(voiceScope.getSnapshot().value),
              // 宿主事实：离线模型的真实阶段与进度（runtime 仍如实报 false）。
              voiceModelFacts(),
            ),
          );
        case "setRealtimeVoice": {
          const next = (msg.params as { next?: unknown } | undefined)?.next;
          if (typeof next === "boolean") void voiceScope.set("realtimeVoice", next);
          return reply(msg.id, undefined);
        }
        case "getVoiceEngine":
          return reply(msg.id, normalizeVoiceSettings(voiceScope.getSnapshot().value).engine);
        case "setVoiceEngine": {
          const engine = (msg.params as { engine?: unknown } | undefined)?.engine;
          if (isVoiceEngine(engine)) void voiceScope.set("engine", engine);
          return reply(msg.id, undefined);
        }
        case "downloadVoiceModel":
          // 真实的离线模型下载（ADR 0061）：宿主 `/herta-voice-model` 点火即返回，
          // 进度靠 `voiceModelFacts()` 轮询回给 `getRealtimeVoice` 与 `voiceModel` 事件。
          // 成功后宿主把模型装到 `$DSH_HOME/tts/herta-best-e72`。
          void postVoiceModel("download").then((s) => reply(msg.id, s));
          return;
        case "onVoiceModel": {
          // 整机那边的 bridge 用 `on("voiceModel", cb)` 本地订阅，父窗口这里
          // 只负责「开始推」：先补一条当前状态，之后每次变化都推。
          const sub = (state: unknown) => push("voiceModel", state);
          voiceModelSubs.add(sub);
          void refreshVoiceModel().then(() => push("voiceModel", voiceModelState));
          return reply(msg.id, undefined);
        }
        case "prepareMiniMaxVoice":
          return reply(msg.id, { phase: "absent" });
        case "onMiniMaxVoice":
          return reply(msg.id, undefined);
        case "clearMiniMaxKey":
          return reply(msg.id, { ok: true, status: emptyKeyStatus() });
        case "setMiniMaxKey":
          // 密钥归 DSH 自己管（credentials / 环境变量），如实拒绝而不是假装存下。
          return reply(msg.id, { ok: false, reason: "rejected" });
        case "cancelVoiceModelDownload":
          // 以前这里是个空实现 —— 点了取消什么都没发生。
          void postVoiceModel("cancel").then(() => reply(msg.id, undefined));
          return;
        case "removeVoiceModel":
          void postVoiceModel("remove").then((s) => reply(msg.id, s));
          return;
        default:
          return fail(msg.id, `整机视图还没有实现 ${String(msg.method)}`);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      // 整机视图卸载：订阅者与轮询都该停 —— 否则每挂一次就多留一个定时器。
      voiceModelSubs.clear();
      if (voiceModelTimer !== null) {
        clearInterval(voiceModelTimer);
        voiceModelTimer = null;
      }
    };
  }, []);

  return createElement("iframe", {
    ref: frameRef,
    "data-dsh-herta-view": "full",
    src: "/herta-ui/",
    title: "黑塔 · 整机",
    style: {
      width: "100%",
      // 槽位不一定给出确定高度，所以两个都给：父容器有高度就用 100%，
      // 没有就退到视口高度减掉顶栏/输入区的估值。
      height: "100%",
      minHeight: "70vh",
      border: "0",
      display: "block",
    },
  });
}

// ── 设置页：「黑塔」（`settings.section` 的独立一页）──────────────────────────
//
// 为什么是独立一页而不是靠 schema 自动生成：
//   · 这一页有 14 项、分四组，自动表单一长条读不动；
//   · 枚举项（语言、主题、引擎、模型）要的是分段选择器，不是文本框；
//   · 「工作区」那组还要说明「留空 = 不同步」，那是文案不是 schema 能表达的。
// 宿主侧因此声明了 `configure({auto:false})`（与所有官方自带页插件一致），
// 免得将来某个客户端按 schema 生成页时多出一页。
//
// 页面**不自持状态**：值全部来自 `ctx.configForms.get("herta")` 的快照，
// 写入直接 `form.set(field, value)`（它自己带 revision 栅栏、串行化、失败重读）。
// 乐观更新是没必要的 —— 宿主接受后镜像会自己推进一帧。

/** 分组。字段名来自宿主的字段表，这里只负责分组与文案。 */
const SETTINGS_GROUPS = [
  { title: "界面", fields: ["locale", "interactionLanguage", "theme"] },
  { title: "窗口与更新", fields: ["closeToTray", "autoUpdate", "deviceScene"] },
  { title: "语音", fields: ["voiceEngine", "realtimeVoice"] },
  {
    title: "工作区",
    // 整机的工作区偏好是**每个工作区各一份文件**，所以这一组先要一个路径。
    hint: "整机在每个工作区各存一份设置。填上工作区根目录后，下面这几项会写进 <工作区>\\.herta\\settings.json；留空 = 不同步。",
    fields: ["workspace", "dreamEnabled", "backendThinking", "backendContract", "modelsActor", "modelsBackend"],
  },
];

/** 枚举值的中文文案。键必须与字段表里的取值域一致（不一致就原样显示英文值）。 */
const ENUM_LABELS = {
  locale: { "": "跟随系统", zh: "中文", en: "English" },
  interactionLanguage: { follow: "跟随界面", zh: "中文", en: "English" },
  theme: { system: "跟随系统", light: "浅色", dark: "深色" },
  voiceEngine: { local: "本地模型", minimax: "MiniMax 克隆", mimo: "MiMo 合成" },
  backendThinking: { low: "low", high: "high", max: "max" },
  backendContract: { standard: "standard", minimal: "minimal" },
  modelsActor: { "deepseek-v4-pro": "V4 Pro", "deepseek-flash": "V4.1 Flash" },
  modelsBackend: { "deepseek-v4-pro": "V4 Pro", "deepseek-flash": "V4.1 Flash" },
};

/** 每项的说明。写清「改完什么时候生效」——她要重启的那几项必须说出来。 */
const FIELD_HINTS = {
  locale: "整机界面自己的语言。「跟随系统」= 不写这个键，按操作系统语言解析。",
  interactionLanguage: "她被提示用哪种语言说话。只影响新会话。",
  theme: "整机界面的明暗。",
  closeToTray: "点窗口关闭时收进托盘还是退出。立刻生效。",
  autoUpdate: "自动检查更新。关掉不影响手动检查。",
  deviceScene: "差分协处理器页上的 3D 设备卡。",
  voiceEngine: "她说话用哪个引擎。",
  realtimeVoice: "实时语音总开关。",
  workspace: "整机的工作区根目录（绝对路径）。留空 = 不动任何工作区文件。",
  dreamEnabled: "她空闲时自己写废案。她那边重启后生效。",
  backendThinking: "板砖的推理档位。她那边重启后生效。",
  backendContract: "板砖的工具契约。她那边重启后生效。",
  modelsActor: "驱动黑塔说话的模型。她那边重启后生效。",
  modelsBackend: "驱动板砖的模型。她那边重启后生效。",
};

/** 选择器要用的空数组常量：引用必须稳定，否则 useSyncExternalStore 会自激。 */
const EMPTY_WORKSPACES = Object.freeze([]);

const SECTION_STYLE = { display: "grid", gap: 28, padding: "4px 2px 32px", maxWidth: 720 };
const GROUP_TITLE_STYLE = {
  margin: "0 0 10px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--dsw-alias-label-secondary)",
  letterSpacing: "0.02em",
};
const ROW_STYLE = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  padding: "10px 0",
  borderTop: "1px solid var(--dsw-alias-border-l1)",
};
const LABEL_STYLE = { fontSize: 13, color: "var(--dsw-alias-label-primary)", lineHeight: "20px" };
const HINT_STYLE = { marginTop: 3, fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: "17px" };
const NOTE_STYLE = { marginTop: 4, fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" };
const INPUT_STYLE = {
  width: 300,
  maxWidth: "42vw",
  boxSizing: "border-box",
  padding: "5px 9px",
  fontSize: 13,
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-bg-layer-2)",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 6,
  outline: "none",
};
const SUGGEST_STYLE = {
  marginTop: 6,
  fontSize: 12,
  color: "var(--dsw-alias-brand-primary)",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
  textAlign: "left",
};

/**
 * 运行时从模块加载器取一个种子模块。
 *
 * ## 为什么不用 `import()`
 *
 * 客户端 bundle 被包成 `__ModuleLoader__.load({ factory: (require) => … })`：
 * 外壳**冻结的模块表只通过工厂参数 `require` 暴露**。esbuild 会把**外部**模块的
 * 动态 `import()` 原样保留（实测产物里就是 `import("@deepseek-ai/…")`），
 * 于是浏览器自己拿原生解析器去解析 —— 那里没有这张表，报
 * `Failed to resolve module specifier '@deepseek-ai/dsh-client-ui-primitives'`。
 *
 * ## 为什么也不直接静态 import
 *
 * 静态 import 会正确变成 `require("…")`（见产物里 `require("react")`），
 * 但它发生在**求值期**：模块不在表里就让整份 bundle 失败 —— 连她的两个对话
 * 页签一起没了。所以这里用**变量 specifier** 调一次运行时的 `require`：
 * 落到工厂参数上（正确通道），又不被构建期解析，于是失败能被 caller 的 try 关住。
 *
 * @param id - 包名。
 * @returns 该模块的命名空间；调用方自己核对要用到的导出。
 */
function loadSeedModule(id: string): any {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 工厂参数，不是全局 require
  return require(id);
}

/**
 * 造「黑塔」设置页组件。
 *
 * @param ui - 模块加载器给的 `@deepseek-ai/dsh-client-ui-primitives`。
 * @returns 组件。
 */
function createSettingsSection(ui: unknown) {
  const { Switch, SegmentedControl } = ui as { Switch: any; SegmentedControl: any };

  /** 一行：左标签 + 说明，右控件（+ 覆盖时的「跟随整机」复位）。 */
  function Row(props: {
    label: string;
    hint?: string;
    control: unknown;
    overridden?: boolean;
    onReset?: () => void;
  }): unknown {
    return createElement(
      "div",
      { style: ROW_STYLE },
      createElement(
        "div",
        { style: { flex: "1 1 auto", minWidth: 0 } },
        createElement("div", { style: LABEL_STYLE }, props.label),
        props.hint === undefined ? null : createElement("div", { style: HINT_STYLE }, props.hint),
        props.overridden !== true || props.onReset === undefined
          ? null
          : createElement(
              "button",
              { type: "button", style: SUGGEST_STYLE, onClick: props.onReset },
              "↺ 跟随整机",
            ),
      ),
      createElement("div", { style: { flex: "0 0 auto", paddingTop: 1 } }, props.control),
    );
  }

  /** 分段选择器；取值域直接来自字段表，所以加一项不用改这里。 */
  function EnumControl(props: { field: string; value: unknown; disabled?: boolean; onChange: (next: string) => void }): unknown {
    const spec = FIELDS[props.field];
    const labels = (ENUM_LABELS as Record<string, Record<string, string>>)[props.field] ?? {};
    const options = (spec.values as readonly string[]).map((value) => ({
      value,
      label: labels[value] ?? value,
    }));
    return createElement(SegmentedControl, {
      id: `herta-setting-${props.field}`,
      value: typeof props.value === "string" ? props.value : spec.def,
      options,
      label: spec.label,
      disabled: props.disabled === true,
      onChange: props.onChange,
    });
  }

  /**
   * 「同步到工作区」的路径输入。
   *
   * 独立组件，好让它成为 `useWorkspaces` 的**唯一调用点**：只有当
   * `settings.section` 真的带了这个标准 prop 时才挂载它，钩子调用次数因此
   * 与渲染次数无关（合规），也不会因为 prop 缺席而炸整页。
   */
  function WorkspacePicker(props: { useWorkspaces: any; onPick: (path: string) => void; disabled?: boolean }): unknown {
    const items = props.useWorkspaces((snapshot: unknown) => (snapshot as { items?: unknown })?.items ?? EMPTY_WORKSPACES);
    if (!Array.isArray(items) || items.length === 0) return null;
    return createElement(
      "div",
      { style: { marginTop: 8, display: "grid", gap: 4 } },
      createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, "从 DSH 已登记的工作区里选："),
      ...items
        .filter((item: unknown) => typeof (item as { path?: unknown })?.path === "string")
        .slice(0, 8)
        .map((item: any) =>
          createElement(
            "button",
            {
              key: item.path,
              type: "button",
              style: SUGGEST_STYLE,
              disabled: props.disabled === true,
              onClick: () => props.onPick(item.path),
            },
            `${item.title ?? item.path} — ${item.path}`,
          ),
        ),
    );
  }

  /** 路径输入：本地暂存草稿，失焦或回车才写（逐键写会把 profile 补丁刷爆）。 */
  function WorkspaceInput(props: { value: string; disabled?: boolean; onCommit: (next: string) => void; useWorkspaces: any }): unknown {
    const [draft, setDraft] = useState(props.value);
    useEffect(() => {
      // 外部值变了（例如从下面的建议里选了）就同步草稿。
      setDraft(props.value);
    }, [props.value]);
    return createElement(
      "div",
      null,
      createElement("input", {
        type: "text",
        value: draft,
        disabled: props.disabled === true,
        spellCheck: false,
        placeholder: "例如 E:\\deepseek工作区",
        style: INPUT_STYLE,
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === "Enter") props.onCommit(draft);
        },
        onBlur: () => {
          if (draft !== props.value) props.onCommit(draft);
        },
      }),
      props.useWorkspaces === undefined
        ? null
        : createElement(WorkspacePicker, {
            useWorkspaces: props.useWorkspaces,
            disabled: props.disabled,
            onPick: (path: string) => {
              setDraft(path);
              props.onCommit(path);
            },
          }),
    );
  }

  return function HertaSettingsSection(props: {
    useHertaMachine?: (selector: (snapshot: unknown) => unknown) => unknown;
    setHertaField?: (field: string, value: unknown) => void;
    clearHertaField?: (field: string) => void;
    useWorkspaces?: unknown;
  }): unknown {
    const snapshot = (typeof props.useHertaMachine === "function"
      ? props.useHertaMachine((s: unknown) => s)
      : undefined) as { status?: string; value?: unknown; writable?: boolean } | undefined;
    const values = useMemo(() => normalizeSettings(snapshot?.value), [snapshot]);

    const header = createElement(
      "div",
      null,
      createElement("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 6 } }, "黑塔 · 整机"),
      createElement(
        "div",
        { style: NOTE_STYLE },
        "这一页改的是她自己的整机设置：写入落进 DSH 的 profile 配置，再同步到整机读的那几份 settings.json。",
      ),
      createElement(
        "div",
        { style: NOTE_STYLE },
        "只写你在这一页改过的项 —— 没动过的项在整机的文件里原样保留，她在自己界面里改的东西不会被覆盖。",
      ),
    );

    if (snapshot?.status !== "ready") {
      const why = snapshot?.status === "unavailable" ? "宿主没有向这个页面提供设置（可能当前部署把设置存在本地）。" : "正在读取设置…";
      return createElement("div", { style: SECTION_STYLE }, header, createElement("div", { style: NOTE_STYLE }, why));
    }

    const disabled = snapshot.writable === false;
    const setField = (field: string, value: unknown) => props.setHertaField?.(field, value);
    // 「覆盖过没有」看的是 `user` 层有没有这个键 —— 不是比较值：
    // 显式设成默认值与从没设过在值上一样、在这里的语义完全不同
    // （前者写回整机，后者不碰她的文件）。
    const userLayer = (snapshot as { user?: unknown }).user;
    const isOverridden = (field: string) =>
      userLayer !== null && typeof userLayer === "object" && Object.prototype.hasOwnProperty.call(userLayer, field);

    const groups = SETTINGS_GROUPS.map((group) => {
      const rows = group.fields
        .filter((field) => field in FIELDS)
        .map((field) => {
          const spec = (FIELDS as Record<string, any>)[field];
          const value = (values as Record<string, unknown>)[field];
          let control: unknown;
          if (spec.kind === "boolean") {
            control = createElement(Switch, {
              checked: value === true,
              label: spec.label,
              disabled,
              onChange: (next: boolean) => setField(field, next),
            });
          } else if (spec.kind === "enum") {
            control = createElement(EnumControl, {
              field,
              value,
              disabled,
              onChange: (next: string) => setField(field, next),
            });
          } else {
            control = createElement(WorkspaceInput, {
              value: typeof value === "string" ? value : "",
              disabled,
              onCommit: (next: string) => setField(field, next),
              useWorkspaces: props.useWorkspaces,
            });
          }
          return createElement(Row, {
            key: field,
            label: spec.label,
            hint: FIELD_HINTS[field],
            control,
            overridden: isOverridden(field),
            // 「跟随整机」= 清掉该字段的 DSH 覆盖，此后它重新由她自己的文件决定
            // （下次挂载还会把她的当前值搬回来）。没有这个复位，用户一旦碰过某项
            // 就再也回不到「跟随她」，而那是个只能进不能出的决定。
            onReset: () => props.clearHertaField?.(field),
          });
        });
      return createElement(
        "section",
        { key: group.title },
        createElement("h3", { style: GROUP_TITLE_STYLE }, group.title),
        group.hint === undefined ? null : createElement("div", { style: { ...NOTE_STYLE, marginTop: -6, marginBottom: 6 } }, group.hint),
        ...rows,
      );
    });

    return createElement("div", { style: SECTION_STYLE }, header, ...groups);
  };
}

/**
 * 绑定设置表单并挂上「黑塔」设置页。
 *
 * 两步都是**惰性**的，这是有意的：
 *   · `ctx.inject(["configForms","slots"], …)` 而不是写进 `inject` 数组 ——
 *     没有设置 UI 的组合（无头 / SDK）里这两个服务不存在，硬依赖会让
 *     整个客户端插件永不挂载，连她的对话页签一起没。
 *   · 原语用动态 import —— 解析失败只损失这一页，不影响其余界面。
 *
 * @param ctx - 客户端 cordis 上下文（只需要 `inject`）。
 * @param mark - 诊断标记对象（DSH 不把客户端上下文暴露到 window）。
 */
function installSettingsSection(ctx: { inject(names: readonly string[], callback: (scoped: any) => unknown): unknown }, mark: Record<string, unknown>): void {
  ctx.inject(["configForms", "slots"], (scoped) => {
    const form = scoped.configForms.get(MACHINE_NS) as MachineForm;
    machineForm = form;
    mark.settingsBound = true;
    mark.settingsNamespace = MACHINE_NS;

    // 原语走模块加载器（见 `loadSeedModule` 的注释）；拿不到就只损失这一页。
    let Component: unknown;
    try {
      const ui = loadSeedModule("@deepseek-ai/dsh-client-ui-primitives");
      if (typeof ui?.Switch !== "function" || typeof ui?.SegmentedControl !== "function") {
        throw new Error(`原语模块缺少 Switch / SegmentedControl（拿到的是 ${Object.keys(ui ?? {}).slice(0, 8).join(", ") || "空对象"}）`);
      }
      Component = createSettingsSection(ui);
    } catch (error) {
      mark.settingsSectionError = String((error as Error)?.message ?? error);
      console.log(`[dsh-herta] 设置页未挂载：${String((error as Error)?.message ?? error)}`);
      return;
    }

    scoped.effect(
      () =>
        // `slots.inject` 而不是裸 register：`settings.section` 这个槽是由
        // ui-settings-general 的 `sidebar.settings` 一并声明的，不等声明到位
        // 就 register 会静默落空。inject 会在槽坍塌时自动撤下贡献。
        scoped.slots.inject("settings.section", () =>
          scoped.slots.register(
            {
              name: "settings.section",
              id: MACHINE_NS,
              // account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20)
              order: 30,
              label: () => "黑塔",
              inject: () => ({
                hooks: { hertaMachine: form },
                setHertaField: (field: string, value: unknown) => {
                  void writeMachineField(field, value);
                },
                clearHertaField: (field: string) => {
                  void followMachineField(field);
                },
              }),
            },
            Component,
          ),
        ),
      "dsh-herta: settings section",
    );
    mark.settingsSectionRegistered = true;
  });
}

/**
 * 注册视图。
 *
 * `slots.inject(name, register)` 是 DSH 唯一支持的组合方式（见仓库
 * `packages/client/AGENTS.md` 的「Slot and props discipline」第 1 条）：
 * 它等真正的槽声明出现，槽坍塌时自动撤下贡献，重声明后重跑，
 * 并且随调用方插件的 fiber 一起释放。
 */
function apply(ctx: {
  uiConversation: { binding(sessionId: string): { target(id: string): unknown } };
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  /** 按需注入一个服务（服务缺席时回调不触发，不会卡住已注册的视图）。 */
  inject(names: readonly string[], callback: (scoped: any) => unknown): unknown;
}): void {
  // 诊断标记。DSH 不把客户端的 cordis 上下文暴露到 window，所以这是从外部
  // （无头浏览器 / CDP）确认插件走到哪一步的唯一可靠信号。
  const mark: Record<string, unknown> = {
    applyRan: true,
    slotsResolved: true,
    viewRegistered: false,
    viewMounted: false,
    viewId: VIEW_ID,
    plugin: name,
  };
  (globalThis as Record<string, unknown>).__DSH_HERTA__ = mark;

  // 设置：绑定 DSH 的设置表单 + 在设置里挂上「黑塔」一页。
  // `voiceScope` 也从这一份表单读，所以整机面板与 DSH 设置页永远同值。
  installSettingsSection(ctx, mark);

  ctx.slots.inject("conversation.view", () => {
    const disposer = ctx.slots.register(
      {
        name: "conversation.view",
        id: VIEW_ID,
        order: 20,
        label: () => "黑塔",
        // 首个订阅会激活 chat target；此后它随会话常驻。
        inject: (sessionId: string) => ({
          hooks: { hertaChat: ctx.uiConversation.binding(sessionId).target("chat") },
        }),
      },
      HertaView,
    );
    mark.viewRegistered = true;
    return disposer;
  });

  // 第二个页签：整机（甲）。它同样订阅 chat target —— 数据由这个组件映射成
  // 她的记录后用 postMessage 推给 iframe，而不是让 iframe 自己去连 DSH 的传输层。
  ctx.slots.inject("conversation.view", () => {
    const disposer = ctx.slots.register(
      {
        name: "conversation.view",
        id: FULL_VIEW_ID,
        order: 30,
        label: () => "黑塔·整机",
        // `sessionId` 由会话作用域的槽自带，不用 inject 再返回一次。
        inject: (sessionId: string) => ({
          hooks: { hertaChat: ctx.uiConversation.binding(sessionId).target("chat") },
        }),
      },
      HertaFullView,
    );
    mark.fullViewRegistered = true;
    return disposer;
  });
}

export { apply, inject, name };
