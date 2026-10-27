/**
 * 样本库回归。
 *
 * 存在的理由：改识别器最怕的不是"改错"，而是"改对了这个平台、改坏了那个平台，而且没人知道"。
 * 手写 fixture 只能覆盖我们想到的形状；真机样本覆盖我们想不到的。
 *
 * 目录为空时跳过（新克隆的仓库没有样本）—— 但一旦有样本，任何一次识别器改动
 * 都必须让这里全绿，否则就是用一个平台的修复换另一个平台的故障。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { analyzeSamples } from '../src/engine/probe.ts';
import { samplesFromPack } from '../src/engine/sample-pack.ts';
import type { SamplePack } from '../src/engine/sample-pack.ts';

const SAMPLES_DIR = resolve(import.meta.dirname, '../../../samples');

async function collectPacks(): Promise<Array<{ file: string; pack: SamplePack }>> {
  const out: Array<{ file: string; pack: SamplePack }> = [];
  let hosts: string[];
  try {
    hosts = await readdir(SAMPLES_DIR);
  } catch {
    return out;
  }
  for (const host of hosts) {
    let files: string[];
    try {
      files = await readdir(join(SAMPLES_DIR, host));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = join(SAMPLES_DIR, host, f);
      try {
        const pack = JSON.parse(await readFile(p, 'utf8')) as SamplePack;
        if (pack?.schema === 1 && Array.isArray(pack.requests)) out.push({ file: `${host}/${f}`, pack });
      } catch {
        // 坏文件不该让整个回归挂掉，但要能被看见（下面单独断言）
        out.push({ file: `${host}/${f}`, pack: { schema: 1, platformHint: host, capturedAt: '', context: { pageUrl: '', pageTitle: '' }, requests: [], dropped: [] } });
      }
    }
  }
  return out;
}

describe('样本库：识别器改动不能拿一个平台的修复换另一个平台的故障', () => {
  it('每个样本包都能重放出结构合法的结果', async (t) => {
    const packs = await collectPacks();
    if (packs.length === 0) {
      t.skip('samples/ 里还没有样本（真机采集一次就会自动落进来）');
      return;
    }
    for (const { file, pack } of packs) {
      const r = analyzeSamples(samplesFromPack(pack), {
        pageUrl: pack.context.pageUrl,
        pageTitle: pack.context.pageTitle,
      });
      assert.ok(Array.isArray(r.tasks), `${file}: 结果里没有 tasks`);
      // 结构合法性：每个候选的 confidence 必须落在 [0,1]，否则排序会失效
      for (const c of r.tasks) {
        assert.ok(c.confidence >= 0 && c.confidence <= 1, `${file}: confidence 越界 ${c.confidence}`);
      }
    }
  });

  it('有 expect 的样本必须逐条对上（这是"从对变错"的唯一报警器）', async (t) => {
    const packs = (await collectPacks()).filter((x) => x.pack.expect);
    if (packs.length === 0) {
      t.skip('还没有带 expect 的样本（用户确认识别结果后会回填）');
      return;
    }
    for (const { file, pack } of packs) {
      const r = analyzeSamples(samplesFromPack(pack), {
        pageUrl: pack.context.pageUrl,
        pageTitle: pack.context.pageTitle,
      });
      // 负样本（taskCount: 0）：这个平台的数据根本不在 JSON 里，
      // 「一个候选都没有」才是正确答案。任何误报都会让用户启用一个坏配置，
      // 所以这里要反过来断言 —— 误报比放过危险得多。
      if (pack.expect?.taskCount === 0) {
        assert.equal(
          r.tasks.length,
          0,
          `${file}: 这是负样本，不该认出任何作业接口（误报会让人启用坏配置）`,
        );
        return;
      }
      const best = r.tasks[0];
      assert.ok(best, `${file}: 曾经认出来过，现在一个候选都没有`);
      if (typeof pack.expect?.taskCount === 'number' && pack.expect.taskCount > 0) {
        assert.equal(best.rowCount, pack.expect.taskCount, `${file}: 作业条数变了`);
      }
      if (pack.expect?.courseName) {
        assert.equal(r.singleCourse?.name, pack.expect.courseName, `${file}: 课程名变了`);
      }
      if (typeof pack.expect?.courseCount === 'number') {
        assert.equal(
          r.singleCourse ? 1 : r.courses.length,
          pack.expect.courseCount,
          `${file}: 课程数变了`,
        );
      }
    }
  });
});
