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
      const msg = event.data as { __herta?: boolean; kind?: string; id?: number; method?: string };
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
        case "getLocale":
          return reply(msg.id, "zh");
        case "getTheme":
          return reply(msg.id, currentDshTheme());
        case "getCloseToTray":
          return reply(msg.id, true);
        case "getDreamConfig":
          return reply(msg.id, { enabled: true });
        case "getDeepSeekKeyStatus":
          return reply(msg.id, { set: true, hint: "dsh", encrypted: true });
        case "listSessions":
          // 整机视图目前只服务「当前这一个 DSH 会话」，所以她自己的会话列表是空的。
          return reply(msg.id, []);
        case "maybePlayEasterEgg":
          return reply(msg.id, undefined);
        default:
          return fail(msg.id, `整机视图还没有实现 ${String(msg.method)}`);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
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
