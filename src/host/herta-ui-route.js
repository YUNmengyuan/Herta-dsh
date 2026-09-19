/**
 * 「Herta 整机」页面的路由常量与目录解析。
 *
 * 页面产物在 `lib/herta-ui/`（与 `lib/index.js` 同级），所以从 `lib/` 往上一级
 * 找到包根，再进 `lib/herta-ui/`。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 页面在包里的位置（构建产物）。 */
export const HERTA_UI_DIR = join(HERE, "herta-ui");

/** 路由前缀。 */
export const HERTA_UI_ROUTE = "/herta-ui";

/** 页面是否已构建 —— 没构建时给一句可操作的提示，而不是一个 404 迷宫。 */
export function hertaUiReady() {
  return existsSync(join(HERTA_UI_DIR, "index.html"));
}
