/**
 * 集成测试用的 ESM resolve hook。
 *
 * ## 为什么需要它
 *
 * 本仓库**刻意不带 `node_modules`**（插件是 `dsh plugin add` 装进 profile 的），
 * 而 `supervisor-llm.js` / `dream-distill-llm.js` 又静态 import
 * `@deepseek-ai/dsh-llm`。所以在仓库里直接 `import` 那两个文件会
 * `ERR_MODULE_NOT_FOUND` —— Node 的 ESM 从**被导入文件**的位置解析，
 * 在测试目录放软链接是没用的（试过）。
 *
 * 这个 hook 把 `@deepseek-ai/*` 指向本机 DSH 运行时的那份 node_modules。
 *
 * ## 用法
 *
 * ```powershell
 * node --import <此文件> scripts/test-llm-integration.mjs
 * ```
 *
 * 注意：**这不是生产路径**。DSH 真正加载插件时，解析基准是 profile 根
 * （`cordis-plugin-loader/lib/index.js:274` 的 `this.ctx.baseUrl`），
 * 见 `docs/叙述调度层设计.md` §5。这里只是让测试能在仓库里跑。
 */
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 本机 DSH 运行时的 `node_modules`。
 *
 * 优先 `$DSH_MODULES`；否则用 `$DSH_PACKAGES`（指到 `…/node_modules/@deepseek-ai`
 * 时的上一级）推断；再退回几处本机已知的解包位置。都找不到就**明确报错**，
 * 而不是静默指向一个已不存在的树 —— 那只会给出误导性的解析错误。
 *
 * 下面那两条硬路径是**机器事实，不是契约**，所以它们会随本机安装变化而失效
 * （旧版桌面安装 `E:\DeepSeek H\…` 已被卸载，于是这条链只剩最后的兜底）。
 * 换机器、换版本时请用 `$DSH_MODULES` 显式指定：
 *
 * ```powershell
 * $env:DSH_MODULES = "C:\path\to\dsh\node_modules"
 * ```
 *
 * 注意**不能**指到桌面应用的 `resources\app.asar\dsh\node_modules`：
 * 那是 asar 归档，只有 Electron 打过补丁的 fs 才读得进去，裸 Node 会看不见。
 * 所以本机用的是解包出来的那份 0.1.7-rc.2 运行时（`dsh-017`）。
 */
function detectDshModules() {
  const candidates = [
    process.env.DSH_MODULES,
    process.env.DSH_PACKAGES === undefined ? undefined : dirname(process.env.DSH_PACKAGES),
    "E:/deepseek工作区/HerTa/dsh-017/node_modules",
    "E:/DeepSeek H/data/runtime/dsh/node_modules",
  ].filter((c) => c !== undefined && c !== "");
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    [
      "找不到 DSH 运行时的 node_modules（集成测试要借它的 @deepseek-ai/* 包）。",
      "请显式指定，例如：",
      '  $env:DSH_MODULES = "C:\\path\\to\\dsh\\node_modules"',
      "试过这些位置：",
      ...candidates.map((c) => `  ${c}`),
    ].join("\n"),
  );
}

const DSH_MODULES = detectDshModules();

// 用 createRequire 解析**真实入口**，而不是拼 `lib/index.js` ——
// 各包的布局并不一致（例如 schemastery 就不是 lib/index.js）。实测踩过。
const dshRequire = createRequire(`${DSH_MODULES}/__resolve__.js`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@deepseek-ai/")) {
      try {
        return { url: pathToFileURL(dshRequire.resolve(specifier)).href, shortCircuit: true };
      } catch {
        // 解析不了就交回默认流程，让它给出正常的错误信息。
      }
    }
    return nextResolve(specifier, context);
  },
});
