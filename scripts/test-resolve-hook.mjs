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
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

/** 本机 DSH 运行时的 node_modules（三个脚本的默认值都指向这一份）。 */
const DSH_MODULES = "E:/DeepSeek H/data/runtime/dsh/node_modules";

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
