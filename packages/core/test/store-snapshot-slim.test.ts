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

  it('被污染的巨型游标不进 snapshot（避免后续 JSON.stringify 抛 Invalid string length）', async () => {
    const store = new MemoryStore();
    await store.init();
    // 模拟旧版本把 ~200KB 内容写进 course-crawl 游标
    await store.setCursor({ accountId: 'a', kind: 'course-crawl', cursor: JSON.stringify({ x: 'y'.repeat(200_000) }), updatedAt: 't' });
    // 保留一条正常的小游标
    await store.setCursor({ accountId: 'a', kind: 'course-progress', cursor: '2026-11-09T00:00:00.000Z', updatedAt: 't' });
    const snap = store.snapshot();
    const kinds = snap.cursors.map((c) => c.kind);
    assert.ok(!kinds.includes('course-crawl'), '巨型游标应被丢弃');
    assert.ok(kinds.includes('course-progress'), '正常游标应保留');
    // snapshot 必须可安全序列化
    assert.ok(JSON.stringify(snap).length < 100_000);
  });
});
