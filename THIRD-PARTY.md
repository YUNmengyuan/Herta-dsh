# 第三方素材与授权

## 上游项目

本插件的素材与人格语料全部来自 **Herta**（原作者项目）：

- **原作者项目**：Herta —— *THE SELF THAT USES THE AGENT*（`PersonaCLI/Herta`）
- **原作者官网**：<https://www.herta-ai.com/#research>

Herta 为**第三方开发**（其 `LICENSE` 署名 `Copyright (c) 2026 PersonaCLI`），
且为非官方同人作品。本插件是在 Herta 之上的**第三方改造**，
**与 Herta 原作者无隶属、合作或背书关系**。

## `assets/voice/`（80 条 `.opus`，2.5 MB）—— 角色语音

**这批音频不在 Herta 上游的 MIT 授权范围内**，权利另有归属；本仓库现按米哈游官方
同人指引放置法律声明后**随仓库分发**（声明原文见 [`NOTICE.md`](./NOTICE.md)）。

来源：`D:\Herta\resources\voice\`（本机安装的 Herta 0.1.5），原始出处为 Herta 上游仓库的
`data/voice/**`。Herta 的 `LICENSE` 用 SCOPE 段声明 MIT **只覆盖源代码**，并明确排除：

```
packages/gui/build/**          角色图标
packages/gui/resources/**      应用内美术
packages/herta/prompts/**      人格与设定语料、引用台词
website/src/assets/**
website/public/**
data/voice/**                  语音（上游仓库自身并不分发）
```

同时 Herta 为非官方同人作品，其 `electron-builder.yml` 的 copyright 字段写明
非 HoYoverse 背书。

### 收录依据

1. **Herta 原作者已同意**本仓库收录并分发这批素材 —— 解决上游那一层。
2. **米哈游官方口径**：《崩坏：星穹铁道》同人衍生作品创作指引 V2.0（2024-04-18 生效）
   第三条 Q1 明确，不禁止**非商业性质的个人使用**，可基于游戏素材制作并发布衍生内容；
   使用**角色配音 / 声音样本**等素材时**应放置法律声明** —— 即 `NOTICE.md` 中那两句。
   本仓库照此放置。

### 仍然成立的约束

- **仅限非商业用途**：不得出售，不得随商业项目分发。
- **不得作为独立素材包再分发**：官方指引把「纯搬运」（原样转载素材本身）排除在二创许可之外。
  要分发就连同本插件一并分发，并保留 `NOTICE.md`。
- **米哈游保留随时要求移除的权利**：收到要求即删 `assets/voice/` 与
  `preset/agent.cordis.yml`，插件代码（MIT）不受影响。
- 若要用于超出「个人非商业使用」的场景，**声音相关人身权利需自行与配音人员确认并取得授权**
  —— 官方指引明示这一点由使用者自行负责。

`package.json` 的 `files` 里保留 `assets`，以便 `dsh plugin add` 能把语音一起装进去。

## 人格语料（`preset/agent.cordis.yml`，46 KB）

内含 `HertaBio.txt` 正文逐字，来自 `Herta-src/packages/herta/prompts/HertaBio.txt`，
同样属于上表被排除的 `packages/herta/prompts/**`，其中**含引用台词**。

**收录依据与约束同上**（原作者同意 + 米哈游同人指引法律声明 + 仅限非商业）。
该文件是 `build-preset.mjs` 的产物（以随附的 standard preset 为底，只换 persona 行），
配好 `HERTA_SRC` 的机器上跑 `node scripts\build-preset.mjs` 可重新生成。

## 其余

插件自身的代码（`src/`、`scripts/`、`Cordis` 配置）为本次工作新写，可采用 MIT。
