#!/usr/bin/env node
/**
 * 清理 Android 前端资源目录。
 *
 * 为什么必须清理而不是覆盖：tsc 不会删除「上次编译过、这次不再编译」的文件。
 * 改了 tsconfig 的 exclude 之后，旧产物会留在 assets 里 ——
 * 它们可能带着 node: 引用（浏览器加载阶段直接失败），
 * 而且因为**没有出现在本次的编译日志里**，构建脚本的扫描也发现不了。
 * 第一次就踩到了这个坑：mock/server.js 是上一次编译的残留。
 */
import { rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'android/app/src/main/assets/www');

await rm(OUT, { recursive: true, force: true });
console.log(`  已清理 ${relative(ROOT, OUT)}`);
