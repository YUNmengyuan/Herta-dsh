# 第三方素材与授权

## 上游项目

本插件的素材与人格语料全部来自 **Herta**（原作者项目）：

- **原作者项目**：Herta —— *THE SELF THAT USES THE AGENT*（`PersonaCLI/Herta`）
- **原作者官网**：<https://www.herta-ai.com/#research>

Herta 为**第三方开发**（其 `LICENSE` 署名 `Copyright (c) 2026 PersonaCLI`），
且为非官方同人作品。本插件是在 Herta 之上的**第三方改造**，
**与 Herta 原作者无隶属、合作或背书关系**。

## `assets/voice/`（80 条 `.opus`，2.5 MB）

**这批音频不在 MIT 授权范围内，不可随本插件再分发。**

来源：`D:\Herta\resources\voice\`（本机安装的 Herta 0.1.5），原始出处为 Herta 上游仓库的
`data/voice/**`。Herta 的 `LICENSE` 用 SCOPE 段声明 MIT **只覆盖源代码**，并明确排除：

```
packages/gui/build/**          角色图标
packages/gui/resources/**      应用内美术
packages/herta/prompts/**      人格与设定语料、引用台词
website/src/assets/**
website/public/**
data/voice/**
```

同时 Herta 为非官方同人作品，其 `electron-builder.yml` 的 copyright 字段写明
非 HoYoverse 背书。

**因此**：

- 本地自用（本插件跑在你自己机器上）没有问题。
- **不要发布到 npm 或任何公开仓库。**
- 若将来要分发这个插件包，必须先把这批音频替换成你自己合成或有授权的素材，
  或者在 `files` 里排除 `assets/` 并在首次运行时自备。

**本仓库的处理**：`assets/voice/` 已写进 `.gitignore`，**不在版本控制里**。
`package.json` 的 `files` 里仍留着 `assets` —— 那是为了让**本地**
`dsh plugin add` 能把语音一起装进去（`files` 管的是本地打包范围，不是 git 范围）。
公开分发（npm publish / 打 tarball 给别人）之前，**必须把那一行去掉**。

## 人格语料

`preset/agent.cordis.yml` 里的 `HertaBio.txt` 正文逐字来自
`Herta-src/packages/herta/prompts/HertaBio.txt`，同样属于上面被排除的
`packages/herta/prompts/**`。同上：本地自用可以，公开分发不行。

**本仓库的处理**：该文件也已写进 `.gitignore`。它是 `build-preset.mjs` 的
**产物**（以随附的 standard preset 为底，只换 persona 行），所以 clone 后
在配好 `HERTA_SRC` 的机器上跑 `node scripts\build-preset.mjs` 即可重新生成 ——
生成出来的同一份内容留在本机，不必进公开仓库。

## 其余

插件自身的代码（`src/`、`scripts/`、`Cordis` 配置）为本次工作新写，可采用 MIT。
