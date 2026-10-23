#!/usr/bin/env node
/**
 * Android 前端资源构建：编译产物后处理 + 资源拷贝 + 安全校验。
 *
 * 为什么需要单独的脚本而不是只靠 tsc：
 *
 *   1. **tsc 不重写 `#` 子路径导入。** 源码里写 `import { X } from '#core'`，
 *      Node 靠 package.json 的 `imports` 字段解析，浏览器不认识这个前缀。
 *      所以编译后必须把这些说明符改写成相对路径。
 *
 *   2. **必须校验产物里没有 node: 引用。** Node 专有模块一旦进浏览器模块图，
 *      失败发生在**加载阶段**（整个页面白屏），而不是调用阶段 ——
 *      这是最难排查的一类问题。所以构建时就扫描并硬失败。
 *
 *   3. 顺便把前端静态文件拷进 assets，并生成手机端专用的 index.html。
 *
 * 用法：
 *   node_modules/.bin/tsc -p tsconfig.android.json && node scripts/build-android.mjs
 *   （或直接 npm run android:sync）
 */
import { readFile, writeFile, readdir, mkdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'android/app/src/main/assets/www');
const HH_DIR = join(OUT, 'hh');
const PUBLIC_DIR = join(ROOT, 'apps/web/public');

/**
 * `--verify-only`：只校验产物，不改写、不拷贝。
 *
 * 为什么需要它：本脚本做的是**编译后处理**，而 tsc 与它是一条流水线里的两步。
 * 只要有人在两者之间再跑一次 tsc（比如「顺便做个类型检查」），
 * 改写就会被无声地覆盖回去 —— 产出的 APK 看起来正常，装上去却是白屏/卡加载。
 * 这个坑已经踩过一次（0.1.53 真机：一直显示「加载中…」）。
 *
 * 所以把关卡前置到打包前：`android:apk` 会在调 Gradle 之前再校验一遍。
 * 校验必须在**打包前**，而不是只在上游构建时 —— 上游通过不代表此刻的产物是干净的。
 */
const VERIFY_ONLY = process.argv.includes('--verify-only');

/** `#` 前缀说明符 → 输出目录里的真实路径（相对仓库根）。 */
const SPECIFIER_MAP = {
  '#core': 'packages/core/src/index.browser.js',
  '#registry-browser': 'packages/adapters/registry.js',
  '#web-kit': 'packages/web-kit/src/index.js',
  '#api': 'apps/web/src/api.js',
};

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- 0. 检查编译日志

/**
 * TS2877 是**预期内的**：源码里写 `import { X } from '#core/ports/adapter.ts'`，
 * 这是「别名 + .ts 后缀」，tsc 无法在 emit 时重写它（非相对路径），于是报错。
 * 但我们的第 2 步正是做这件事 —— 所以这个错误码可以忽略。
 *
 * 其余任何错误都必须让构建失败：本项目从来没跑过全量 typecheck，
 * 第一次跑就抓出了一个真实的运行时 bug（cdp-http 少了一个 import）。
 */
const TSC_LOG = join(ROOT, '.tsc-android.log');
if (existsSync(TSC_LOG)) {
  const tscLog = await readFile(TSC_LOG, 'utf8');
  const lines = tscLog.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  const fatal = lines.filter((l) => !l.includes('TS2877'));
  if (fatal.length > 0) {
    fail(`编译有 ${fatal.length} 个错误（不是已知的 TS2877）：\n    ` + fatal.slice(0, 20).join('\n    '));
  }
  const benign = lines.length - fatal.length;
  if (benign > 0) log(`  已忽略 ${benign} 个 TS2877（别名 + .ts 后缀，由本脚本改写）`);
  // 清理临时日志失败**不该**让构建失败：它只是诊断产物，删不掉不影响包的正确性。
  // （沙箱/杀软占用文件时 rm 会抛，曾把一次成功的编译报成"构建失败"。）
  await rm(TSC_LOG, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------- 1. 检查编译产物

if (!existsSync(HH_DIR)) {
  fail(
    `没有找到编译产物 ${relative(ROOT, HH_DIR)}。\n` +
      `  请先编译：node_modules/.bin/tsc -p tsconfig.android.json`,
  );
}

// ---------------------------------------------------------------- 2. 改写说明符 + 扫描 node:

const jsFiles = await collectJs(HH_DIR);
let rewritten = 0;
const nodeRefs = [];

for (const file of jsFiles) {
  const original = await readFile(file, 'utf8');

  // 相对当前文件到仓库根的距离，算出回到根需要几级 ../
  const relFromRoot = relative(HH_DIR, file);
  const depth = posix.dirname(relFromRoot.split(/[\\/]/).join('/'));
  const upLevels = depth === '.' ? 0 : depth.split('/').length;
  const prefix = '../'.repeat(upLevels);

  let text = original;

  // 具名/默认导入导出：from '#core' / from '#core/ports/adapter.js'
  for (const [key, target] of Object.entries(SPECIFIER_MAP)) {
    text = text.replaceAll(`from '${key}';`, `from '${prefix}${target}';`);
    text = text.replaceAll(`from "${key}";`, `from "${prefix}${target}";`);
    // 深层子路径：#core/xxx
    text = text.replaceAll(new RegExp(`from '${escapeRe(key)}/([^']+)'`, 'g'), (_m, sub) => {
      const clean = String(sub).replace(/\.ts$/, '.js');
      return `from '${prefix}packages/core/src/${clean}'`;
    });
  }
  // 动态 import('#core')
  text = text.replaceAll(`import('#core')`, `import('${prefix}packages/core/src/index.browser.js')`);
  text = text.replaceAll(`import("#core")`, `import("${prefix}packages/core/src/index.browser.js")`);

  if (!VERIFY_ONLY && text !== original) {
    await writeFile(file, text, 'utf8');
    rewritten += 1;
  }

  // 扫描残留的 node: 引用（静态与动态都要查）。
  // 必须先剥掉注释：我们自己的文档注释里就写了 `import { ... } from 'node:fs'` 当例子，
  // 不剥的话会误报（第一次构建就被自己坑了）。
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1'); // 行注释（用 [^:] 避开 https://）

  const hits = [...code.matchAll(/(?:from|import\s*\()\s*['"]node:[^'"]+['"]/g)];
  for (const h of hits) {
    // 纯类型导入会在编译时被擦除，不产生运行时代码 —— 但要看整个语句，
    // 不能只看同一行（多行 import 的 from 单独成行）。
    const before = code.slice(0, h.index);
    const lastImport = before.lastIndexOf('import');
    const head = lastImport >= 0 ? before.slice(lastImport, lastImport + 14) : '';
    if (/^import\s+type\b/.test(head)) continue;
    nodeRefs.push(`${relFromRoot}: ${h[0]}`);
  }
  // 残留的 # 前缀说明符说明改写没做（或被后续的 tsc 覆盖了）。
  // 这里同时覆盖**子路径**形态（#core/ports/adapter.ts）—— 只查裸说明符会漏掉它们。
  const leftover = [...text.matchAll(/from ['"](#[\w-]+(?:\/[^'"]*)?)['"]/g)].map((m) => m[1]);
  if (leftover.length > 0) {
    fail(
      `${relFromRoot} 里还有未改写的说明符：${[...new Set(leftover)].join(', ')}\n` +
        `  浏览器不认识 # 前缀，页面会卡在加载阶段。\n` +
        `  常见原因：有人在 build-android.mjs 之后又跑了一次 tsc（改写被覆盖）。\n` +
        `  正确做法：整条流水线走 npm run android:sync / android:apk，\n` +
        `  只做类型检查请用 npm run android:typecheck（--noEmit，不会碰产物）。`,
    );
  }
}

if (nodeRefs.length > 0) {
  fail(
    `编译产物里存在 Node 专有模块引用（浏览器加载阶段会直接失败）：\n    ` +
      nodeRefs.join('\n    ') +
      `\n  请把这些模块排除在 tsconfig.android.json 之外，或改成动态 import。`,
  );
}

log(`  已改写说明符：${rewritten}/${jsFiles.length} 个文件`);
log(`  node: 引用扫描：通过（0 处）`);

// ---------------------------------------------------------------- 2.5 导入目标存在性校验

/**
 * 校验每个 import 的相对路径都真的指向一个存在的文件。
 *
 * 为什么需要：踩过一次 —— tsc 把 `#adapters` 输出成了 `packages/adapters/index.js`，
 * 但实际编译的产物是 `registry.js`（别名在 package.json 与 tsconfig 里指向了不同文件）。
 * 这种错误在浏览器里表现为**某个模块 404，页面白屏且报错信息指向无关位置**，
 * 极难排查。构建期一行检查就能拦住。
 */
const badImports = [];
for (const file of jsFiles) {
  const text = await readFile(file, 'utf8');
  const dir = posix.dirname(relative(HH_DIR, file).split('\\').join('/'));
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    const target = posix.normalize(posix.join(dir, spec));
    if (!existsSync(join(HH_DIR, target.split('/').join('\\')))) {
      badImports.push(`${relative(HH_DIR, file)} → ${spec}`);
    }
  }
}
if (badImports.length > 0) {
  fail(
    `有 ${badImports.length} 处 import 指向不存在的文件（浏览器里会表现为白屏）：\n    ` +
      badImports.slice(0, 15).join('\n    '),
  );
}
log(`  import 目标校验：通过（${jsFiles.length} 个文件）`);

if (VERIFY_ONLY) {
  log('  （--verify-only：产物干净，跳过资源拷贝与 index.html 生成）');
  process.exit(0);
}

// ---------------------------------------------------------------- 3. 拷贝前端静态文件

await mkdir(OUT, { recursive: true });

const sharedFiles = ['style.css', 'app.js'];
for (const f of sharedFiles) {
  await cp(join(PUBLIC_DIR, f), join(OUT, f));
}

// 手机端专用 index.html：与桌面共用同一份 UI，只换引导脚本
const desktopHtml = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
const androidHtml = desktopHtml
  .replace(
    /<script src="\/app\.js"><\/script>/,
    '<!-- 手机端：先加载引擎（含原生 HTTP 桥与 fetch 拦截），再由它引导 app.js -->\n' +
      '<script type="module" src="/hh/apps/android/www/main.js"></script>',
  )
  .replace('<title>课业中枢 · HomeworkHub</title>', '<title>课业中枢</title>');
if (androidHtml === desktopHtml) {
  fail('生成 index.html 失败：没找到 <script src="/app.js"> 标记，UI 模板可能改过。');
}
await writeFile(join(OUT, 'index.html'), androidHtml, 'utf8');

// ---------------------------------------------------------------- 4. 汇总

const total = await dirSize(OUT);
log(`  前端资源：${relative(ROOT, OUT)}（${(total / 1024).toFixed(0)} KB）`);
log(`  index.html 已指向 /hh/apps/android/www/main.js`);
log('\n完成。接下来在 Android Studio 里打开 android/ 目录，或命令行：');
log('  cd android && gradle assembleDebug');

// ---------------------------------------------------------------- 工具

async function collectJs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJs(full)));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

async function dirSize(dir) {
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sum += await dirSize(full);
    else sum += (await stat(full)).size;
  }
  return sum;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
