#!/usr/bin/env node
/**
 * 一条命令构建 APK：生成前端资源 → 调 Gradle 打包 → 报告产物。
 *
 * 之所以要有这个脚本，是因为构建分两段、且第二段对环境敏感：
 *   1. tsc 把核心引擎编译成 WebView 能加载的 ESM（含 Node 依赖扫描）
 *   2. Gradle 把 assets + Java 壳打成 APK
 * 中间任何一步失败，手工排查都要来回切目录。
 *
 * 用法：npm run android:apk
 *   环境变量：
 *     ANDROID_HOME / ANDROID_SDK_ROOT —— SDK 路径（也可写进 android/local.properties）
 *     GRADLE_CMD —— 自定义 gradle 命令（默认 gradlew 优先，其次 gradle）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ANDROID_DIR = join(ROOT, 'android');
const APK = join(ANDROID_DIR, 'app/build/outputs/apk/debug/app-debug.apk');

const log = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

function run(cmd, args, cwd) {
  log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
  return r.status ?? 1;
}

// ---------------------------------------------------------------- 1. 前端资源

if (run('node', ['scripts/clean-android.mjs'], ROOT) !== 0) fail('清理失败');

const tsc = join(ROOT, 'node_modules/.bin/tsc');
if (!existsSync(tsc)) {
  fail('找不到 typescript。先执行：npm install');
}
// tsc 的退出码这里不能用 —— 别名 + .ts 后缀会报 TS2877（预期内），
// 真正的问题由 build-android.mjs 校验（node: 引用扫描 + 导入目标校验）。
run('node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.android.json',
  '>', '.tsc-android.log', '2>&1'], ROOT);
if (run('node', ['scripts/build-android.mjs'], ROOT) !== 0) fail('前端资源构建失败');

// 打包前**再校验一次**产物：上游通过不代表此刻的产物干净。
// 踩过：在这两步之间又跑了一次 tsc（顺手做类型检查），把改写覆盖回去，
// 产出的 APK 装上去一直卡「加载中…」—— 界面看起来正常，是最难发现的那类坏。
if (run('node', ['scripts/build-android.mjs', '--verify-only'], ROOT) !== 0) {
  fail(
    '前端产物校验失败（原因见上）。\n' +
      '  只做类型检查请用 npm run android:typecheck（--noEmit，不写产物）。',
  );
}

// ---------------------------------------------------------------- 2. SDK 检查

const localProps = join(ANDROID_DIR, 'local.properties');
const sdkFromEnv = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdkFromEnv && !existsSync(localProps)) {
  fail(
    '没找到 Android SDK。任选一种方式：\n' +
      '  · 设置环境变量 ANDROID_HOME\n' +
      `  · 在 ${localProps} 里写 sdk.dir=<你的 SDK 路径>（Android Studio 会自动生成）`,
  );
}

// ---------------------------------------------------------------- 3. Gradle 打包

const gradleCmd =
  process.env.GRADLE_CMD ?? (existsSync(join(ANDROID_DIR, 'gradlew.bat')) ? 'gradlew.bat' : 'gradle');
const code = run(gradleCmd, ['assembleDebug', '--console=plain'], ANDROID_DIR);
if (code !== 0) {
  fail(
    `Gradle 构建失败（退出码 ${code}）。\n` +
      '  常见原因：JDK 版本不匹配（本项目用 AGP 8.5.2 + JDK 17）、首次构建需要联网下载依赖、或 SDK 缺少 platform 34。',
  );
}

// ---------------------------------------------------------------- 4. 报告

if (!existsSync(APK)) fail(`构建结束了但没找到 APK：${APK}`);
const sizeMb = (statSync(APK).size / 1024 / 1024).toFixed(2);
log(`\n✓ APK 已生成：${APK}（${sizeMb} MB）`);
log('\n安装到手机（USB 调试打开后）：');
log(`  adb install -r "${APK}"`);
log('或直接把 APK 拷进手机点击安装（需允许「安装未知来源应用」）。');
