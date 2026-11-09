/**
 * 存储快照必须裁剪 raw 大对象。
 *
 * 真机 2026-11-09：智慧树共享课/考试的 raw 是完整平台响应，让 snapshot 逼近
 * V8 单字符串上限，JSON.stringify 在落盘时抛 Invalid string length，
 * 表现为「同步请求 0 次就失败」。这里锁定：snapshot 不含巨型 raw，
 * 但运行时需要的 recruitId/secret 必须保留、且能跨重启恢复。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '../src/infra/memory-store.ts';

describe('存储快照裁剪 raw', () => {
  it('巨型 raw 不进 snapshot；recruitId/secret 保留并可恢复', async () => {
    const store = new MemoryStore();
    await store.init();
    const filler: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) filler['f' + i] = 'x'.repeat(5000); // ~1MB
    await store.upsertCourses([{
      id: 'zh:1:1000006248', platformId: 'zh', accountId: '1', platformCourseId: '1000006248',
      name: '心理健康', lastSeenAt: 'x',
      raw: { courseId: 1000006248, recruitId: 368799, secret: 'sekret', ...filler },
    }] as never);

    const snap = store.snapshot();
    const json = JSON.stringify(snap);
    assert.ok(json.length < 200_000, `snapshot 应小于 200KB，实际 ${json.length}`);
    const courseRaw = (snap.courses[0] as { raw?: Record<string, unknown> }).raw ?? {};
    assert.equal(courseRaw.recruitId, 368799);
    assert.equal(courseRaw.secret, 'sekret');
    assert.equal(courseRaw.f0, undefined, '大字段必须被裁掉');

    const restored = MemoryStore.fromSnapshot(snap);
    const c = (await restored.listCourses())[0]!;
    assert.equal((c.raw as { recruitId?: number }).recruitId, 368799, 'restore 后 recruitId 仍在');
  });
});
