/**
 * 「Herta 整机」页面的入口（甲方案）。
 *
 * 这一页跑在 DSH 页面里的 iframe 中，加载的是 Herta **真实的渲染层**
 * （`packages/gui/src/renderer`，与官网 demo 同源），数据由一个 postMessage
 * bridge 从父窗口取（见 ./bridge.ts）。
 *
 * 与乙（conversation.view 里的组件）的关系：乙把她的**展示组件**接到 DSH 的
 * 会话上，是「她在 DSH 里干活」；这一页是她的**整个世界**（侧栏、开场、
 * 设备卡、她自己的会话）。两者共用同一份渲染层代码，互补而不重复。
 */
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "@gui/App";
import { createBridge } from "./bridge.js";

const rootEl = document.getElementById("root");
if (rootEl === null) throw new Error("herta-ui: 页面里没有 #root");

// 渲染层在浏览器里跑需要的两处补偿（与官网 demo 同一套做法）：
//   1. 主题：DSH 把主题写在父窗口上，这里先跟随系统，父窗口起来后会推事件过来
//   2. 语言：先给中文，父窗口的 getLocale 会覆盖
document.documentElement.dataset.theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";

createRoot(rootEl).render(
  StrictMode ? <StrictMode><App bridge={createBridge()} /></StrictMode> : <App bridge={createBridge()} />,
);
