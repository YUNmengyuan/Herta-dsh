# dsh-herta

把 **Herta（黑塔）** 作为一个插件装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：
她的人格、她的记忆、她的声音、她的界面。

四层，各自独立可验：

| 层 | 内容 | 落在哪 |
|---|---|---|
| **A 身份** | `HertaBio.txt` 逐字作人格前缀 + 为 DSH 改写的处境/纪律 | agent preset |
| **B 记忆** | 记忆货架（`.herta/narrative/`）作动态提示词段；四个记忆/做梦工具 | preset 行 |
| **C 语音** | 80 条她本人的 `.opus`（开场白 / 语气词 / 自我收回 / 彩蛋）+ 发声工具 | 静态路由 + client |
| **D 界面** | **乙**：用她的展示组件渲染 DSH 会话；**甲**：iframe 装下她的整机 | `conversation.view` ×2 |

---

## ⚠️ 本仓库不包含的内容（clone 后先看这一节）

这是一个**代码壳仓库**：代码、构建脚本、插件配置、构建产物都在，但
**两样授权受限的素材被 `.gitignore` 排除了**（原因见 [`THIRD-PARTY.md`](./THIRD-PARTY.md)）：

| 缺的东西 | 干什么用的 | 怎么补齐 |
|---|---|---|
| `assets/voice/`（80 条 `.opus`，2.55 MB） | C 层语音：开场白 / 语气词 / 自我收回 / 彩蛋 | 从你本机的 Herta 安装取（Herta 上游 `data/voice/**`） |
| `preset/agent.cordis.yml`（46 KB） | A 层人格正本（内含 `HertaBio.txt` 逐字） | 跑 `node scripts\build-preset.mjs` 重新生成（见下） |

**不补的后果**：`scripts/install-web.mjs` 的前置检查会直接报「缺语音资产」/「缺 preset」
并退出 —— 这是刻意的，宁可明确失败，也不要装出一个半残的插件。

补齐之后，本机使用与构建与完整版完全一致。

### 没有这两样时还能跑什么

- `node scripts\test-mapping.mjs`（31 项）、`test-narrative.mjs`（31 项）、
  `test-dream.mjs`（28 项）—— **纯逻辑单测，不需要素材**
- `node scripts\build.mjs` / `build-herta-ui.mjs` —— 构建 client 半侧与整机页面
  （`build-preset.mjs` 需要 `HERTA_SRC`，因为底本与 `HertaBio.txt` 从那里取）

---

## 装

```powershell
node scripts\install-web.mjs --dry-run   # 只读：先看它会做什么
node scripts\install-web.mjs             # 装进桌面应用的 web profile
# 然后关掉桌面应用窗口，重新打开
```

必须关窗重开：`patchReload: live` 只热重载 patch 文件，而 `dsh.profile.bundles`
的变更是**启动期合成**；桌面应用也没有子进程守护，直接杀掉 `dsh web` 不会自动拉起。

出问题回滚：`node scripts\install-web.mjs --rollback`（之后同样关窗重开）。

回滚按 **home + profile 过滤**备份（每份备份带 `TARGET.json`），不是取"全局最新"——
同一台机器上装过多个 profile 时，取最新会把别人的配置还原到这边来。
该路径已实测：还原后 `bundles` 与 `dependencies` 回到安装前、找不到匹配备份时
明确报错而不是乱还原。

⚠️ 注意 **agent preset 属于整个 DSH home，不属于单个 profile** —— 回滚会连带
处理它，因此会影响同一 home 下所有 profile。

---

## 架构

### 这个包同时挂在两个平面上，两件事不同

| | profile bundle 行（宿主面） | preset 行（agent 面） |
|---|---|---|
| 干什么 | 让 client 半侧进浏览器启动图 + 挂两条静态路由 | 注册她的提示词段与五个工具 |
| 为什么不换 | `dsh-client-modules` 只扫 `loader.entries()`，preset 子树不在其中 | 放宿主面会把工具泄漏给**所有**会话 |
| 怎么区分 | 行上没有 `config` | 行上带 `config: { plane: preset }` |

两个实例的 `apply` 都会跑（模块只求值一次，fiber 是两个），所以**模块级可变状态
必须与平面无关或按 key 索引** —— 缓存按 cwd 索引就是这个原因。

preset 是**懒挂载**的：启动日志里只有 `plane=host` 是正常的，要等第一个真正跑起来的、
属于该 preset 的会话才会出现 `plane=preset`。

### 两条界面路线

**乙**（`conversation.view` id `herta`）—— 用她的展示组件渲染 DSH 会话。数据走
`ctx.uiConversation.binding(sessionId).target('chat')`，组件拿到的是 DSH 的
`ConversationNode[]`，映射成她的气泡。样式挂进 **shadow root**：她原版样式表的
`:root` 变量在 shadow 里不匹配任何元素，所以构建期把 `:root` 转成 `:host`、
删掉整页 chrome（见 `scripts/build.mjs`）。

**甲**（`conversation.view` id `herta-full`，页签显示「黑塔·整机」）—— iframe 装下她的整机（`/herta-ui/`）。
iframe 是**独立文档**，所以她的原版样式**原样使用**（`:root` / `body` 整页规则在这里
正好是对的）。数据经 postMessage bridge 从父窗口取；bridge 会把每个调用的**最后一条
载荷缓存下来补给新订阅者** —— 不这么做，早期那次 reset 会在渲染层订阅之前丢掉，
现象是「界面起来了但会话是空的，而且不会恢复」。

**整机页要去掉两处「宿主已经有的 chrome」**（都落在薄层 `src/herta-ui/herta-ui.css`，
两条规则，上游 `Herta-src/` 一行没动）：

| 去掉的 | 为什么 |
|---|---|
| `.composer`（她自己的输入框） | DSH 底部本来就有一整套输入区，两套并存；且她那套走 `bridge.submitText`，而 bridge **没实现**这个方法，发出去的话只会丢在地上 |
| `.window-controls`（右上角最小化/最大化/关闭） | 三个都是**死按钮** —— bridge 把它们全实现成空函数（iframe 里也没有「窗口」可最小化，该最小化的是外层 DSH 窗口） |

两处都只圈元素自己的 class、不碰父级，所以布局自动让位：`.workspace` 的
`grid-template-rows:1fr auto` 里那个 `auto` 行会跟着子项自己塌，对话区直接长满
（实测 452px → 512px），不留空档也不出双重滚动条。

### 两条静态路由

都是**白名单**：启动时扫出文件索引，请求路径必须命中，否则 404。不存在路径穿越的
可能，也就不需要 `../` 过滤这类容易写错的代码。

- `/herta-voice` —— 80 条语音 + 代码生成的 `index.json`
- `/herta-ui` —— 整机页面（html / js / css / 开场段 / pdf worker）

---

## 五个工具

| 工具 | 作用 |
|---|---|
| `herta_narrative_list` | 列出记忆货架，并如实报告哪份进了当前提示词、哪份被门拦下 |
| `herta_narrative_read` | 读某一份的完整正文 |
| `herta_memory_save` | 随手记一笔（过格式门 + 标题新颖性） |
| `herta_dream` | 做梦：门槛更高（另加篇幅下限），并记进做梦账本 |
| `herta_speak` | 让模型能主动发声；片段信息经 `presentationMeta` 落到工具结果的 `meta` 上，浏览器侧读取后播放 |

## 三道门

记忆内容会进她的系统提示词，所以写入必须过滤：

1. **格式门** —— 与读取端同一道（逐字移植 Herta 的 `few-shot-guard`）：对话栅栏必须
   平衡、不嵌套、到 EOF 全关；首行必须是 `### 废案` / `### 记录` 头；单个文件不超过
   1 万估算 token。**检查的是结构不是词汇** —— 上游第一版用词表判断，把全部 18 份
   活样本静默丢了 25 天。
2. **标题新颖性** —— 逐字移植 `novelty.ts`（含「文件名消毒后同名」那个坑与连载篇豁免）。
3. **token 预算** —— 实测她真实货架折合 **47445 tokens**，全部注入不可接受。默认预算
   12000，按「最新优先」挑选，但**拼装时排回升序**（拼接顺序与挑选顺序无关，否则
   同样内容会产出不同前缀、打散 KV 缓存）。

---

## 开发

```powershell
node scripts\build.mjs           # client 半侧（esbuild + 模块加载器包装）
node scripts\build-preset.mjs    # agent preset（以随附 standard 为底，只换 persona 行）
node scripts\build-herta-ui.mjs  # 整机页面
node scripts\deploy.mjs          # 三样都构建 + 镜像进 lab profile
node scripts\test-narrative.mjs  # 货架逻辑（31 项）
node scripts\test-dream.mjs      # 做梦逻辑（28 项）
node scripts\test-mapping.mjs    # DSH↔Herta 映射（31 项）
```

`npm test` 跑后三个（共 90 项）。

`src/shared/mapping.js` 是**纯函数**、不 import 任何东西，所以 Node 能直接测、
esbuild 也能原样打进 client bundle —— 一份代码两个消费者，不需要额外构建步骤。
之所以把它从客户端里抽出来：那是客户端逻辑最密的一段（11 种节点 → 3 种块），
埋在 `.tsx` 里就只能靠浏览器验证。

改动落在 `dsh.profile.bundles` 或 preset 上的，**必须重启实例**才生效。

环境变量：`HERTA_SRC`（Herta 源码树，默认 `E:\deepseek工作区\Herta-src`）、
`DSH_PRESETS`（随附 preset 目录）、`DSH_PROFILE_DIR`（`deploy.mjs` 的目标）。

---

## 已知缺口

- **五个工具从未在真实会话里被调用过** —— 只验证到「进了工具表」与纯逻辑单测。
  lab 里没有 API Key，所以一次真实调用的闭环还没走通。
- **`scripts/` 里有硬编码的本机绝对路径**（`E:\DeepSeek H\...`、`E:\deepseek工作区\...`），
  作者本机可直接跑，**别人 clone 后需要改这几处默认值**（或在 `HERTA_SRC` 等
  环境变量里覆盖）。具体位置：`install-web.mjs`（`HOME` / `DSH_BIN`）、`build.mjs`
  与 `build-herta-ui.mjs`（`HERTA_SRC`）、`deploy.mjs` 与 `build-preset.mjs`。
- **整机页的 `submitText` 未实现** —— 她那套输入框既然已隐藏，这条路径日常碰不到；
  但若要恢复输入框，必须同时把 bridge 的 `submitText` 补上，否则还是发不出消息。
- **C 层客户端消费 cue 的那一半未端到端验证** —— cue 的**抽取**已有单测覆盖
  （`test-mapping.mjs`），但从一个真实的 `herta_speak` 工具结果触发播放，需要
  一次模型调用才能走通。
- **整机的 `listSessions` 返回空** —— 她自己的会话列表 / 开场白 / 设备卡还没接；
  整机目前只服务「当前这一个 DSH 会话」。
- **C2（全量本地 TTS）未做** —— 22 MB `tts-runtime` + 110 MB 模型，有原生模块与体积
  问题，单独评估。
- **整机页面占 20.1 MB**（16 MB JS + 3 MB 开场段）。开场段可以改成首次运行下载。
- **B 层的「知识」部分按计划推迟了**。现在实现的是**记忆**（货架 + 做梦账本 +
  四个工具）；Herta 上游 `@herta/knowledge` 里还有一套 sqlite 知识库
  （canon / 自省提取 / 剧情摄入，数百行）。当初的分期决定是「先把
  `.herta/narrative/` 的文本货架打通，sqlite 留到 B2」。
  她的**身份**不需要它（那由 A 层的人格正本负责），所以不影响她现在的可用性；
  但如果你想要「她记得设定集里的细节」这类能力，那就是这块。

---

## ⚠️ 授权

**语音资产与人设语料不在 Herta 的 MIT 范围内，不可随本插件再分发。**
详见 [`THIRD-PARTY.md`](./THIRD-PARTY.md) —— 公开分发前必须先处理。

---

## 与 Herta 上游的关系

人格正本、格式门、新颖性判定、语音资产都来自 Herta（逐字或逐字移植，出处写在
各处注释里）。**做梦的蒸馏环节被换掉了**：原版是离线自主 pass（约 6700 行，用它
自己的 LLM 蒸馏候选），这里改由她在会话里写候选 —— 在 DSH 里模型就是她本人、
上下文就在眼前，再让宿主另起一次 LLM 调用去「蒸馏她自己」既贵又绕。
保留的是**晋升门**与**做梦账本**。
