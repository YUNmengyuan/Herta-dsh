/**
 * dsh-herta 的部署脚本：构建 → 把产物显式镜像进目标 profile 的 node_modules。
 *
 * 为什么不靠 `dsh plugin add` 重复重装：profile 开了 `nodeLinker: hoisted`，
 * 包是**硬链接**进 node_modules 的。硬链接只在「原地改写」时才会跟着变，
 * 一旦构建器改成「写临时文件再改名」（很常见），profile 里就还是旧代码，
 * 而 pnpm 重复 add 还会撞 `ERR_PNPM_UNEXPECTED_STORE`。所以这里显式拷贝，
 * 不依赖任何链接语义。
 *
 * 用法：
 *   node scripts/deploy.mjs                      # 默认部署到 lab profile
 *   DSH_PROFILE_DIR=<path> node scripts/deploy.mjs
 *
 * 注意：这只用于**开发迭代**。正式安装仍然走
 * `dsh plugin --profile <name> add dsh-herta`。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 默认目标是工作区里的隔离实验 profile，绝不碰桌面应用真正在用的那个 profile。 */
const DEFAULT_PROFILE_DIR = resolve(root, "..", "herta-lab", ".dsh", "profiles", "herta-lab");
const profileDir = process.env.DSH_PROFILE_DIR ?? DEFAULT_PROFILE_DIR;
const target = join(profileDir, "node_modules", "dsh-herta");

// 1) 构建（插件 + preset + 整机页面）
execFileSync(process.execPath, [join(here, "build.mjs")], { stdio: "inherit", cwd: root });
execFileSync(process.execPath, [join(here, "build-preset.mjs")], { stdio: "inherit", cwd: root });
execFileSync(process.execPath, [join(here, "build-herta-ui.mjs")], { stdio: "inherit", cwd: root });

// 2) 镜像插件
if (!existsSync(profileDir)) {
  throw new Error(`目标 profile 不存在：${profileDir}\n先跑一次 dsh --profile herta-lab --from-default-profile web --dump-config`);
}
// **先整棵删掉再拷**，不用 cpSync 的「合并覆盖」语义：Windows 上合并覆盖会被
// 上一位持有者（尤其是刚被杀掉的 dsh 实例）留下的文件句柄挡成 EPERM/EPIPE，
// 而且合并会留下上一版有、这一版没有的陈旧模块。先删是确定性的。
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "lib"), { recursive: true });

// lib/ 整棵镜像过去 —— 里面不只有 host 半侧的各模块，还有 lib/herta-ui/ 整机页面
// （html/js/css/开场段/worker）。写死文件名或只拷一层都会漏。
cpSync(join(root, "lib"), join(target, "lib"), { recursive: true });
// icon.png 必须一起过去：package.json 里 `"icon": "./icon.png"` 指向它，
// 少了它清单读取会记一条 error（图标位置变成诊断信息）。
for (const rel of ["cordis.patch.yml", "package.json", "icon.png"]) {
  copyFileSync(join(root, rel), join(target, rel));
}
// assets/ 也要镜像 —— 80 条语音（2.5 MB）在 assets/voice/ 下，host 半侧按
// `lib/../assets/voice` 找它。少了它语音整档静默失效（不会报错，只是没声）。
cpSync(join(root, "assets"), join(target, "assets"), { recursive: true });
// preset 补丁层也要镜像 —— package.json 的 dsh.bundle.patch 数组指向它，
// 少了它 profile 起不来（loader 找不到 patch 文件）。
cpSync(join(root, "preset"), join(target, "preset"), { recursive: true });
console.log(`插件已部署到 ${target}`);

// 3) 轻量核验：preset 行确实出现在合成结果里。
// 0.1.7 起 preset 不再是 `$DSH_HOME/.agent-presets/<name>/` 目录，所以这里
// 不再往 home 里拷任何东西 —— 它随包一起，作为第二条 bundle patch 生效。
console.log("（preset 随包生效，无需往 $DSH_HOME 拷贝；改了 client 半侧或 preset 后需要重启 dsh web）");
