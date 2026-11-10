/**
 * snapshot 的 raw 白名单必须保留「后续请求要用」的字段。
 *
 * 真机事故（2026-11-10）：白名单只有 recruitId/secret/courseId/homepage，
 * 把超星的 classId/cpi/enc 一起裁掉了。后果极隐蔽 ——
 *   同步当场正常（内存里 raw 完整），**重启 App 后**从 snapshot 恢复才坏：
 *   课程缺 classId → 作业列表发不出 classId → 平台回「提示 无效的用户！」
 *   + 1148 字节空页 → 表现为「15 门课全部 0 条作业」。
 * 这类回归只有落盘/恢复一轮才暴露，所以必须有测试盯着。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryStore } from '../src/infra/memory-store.ts';
import type { UnifiedCourse } from '../src/domain/course.ts';

function makeCourse(raw: Record<string, unknown>): UnifiedCourse {
  return {
    id: 'chaoxing::a1:204587864',
    platformId: 'chaoxing',
    accountId: 'chaoxing::a1',
    platformCourseId: '204587864',
    name: '数据结构实践',
    lastSeenAt: new Date().toISOString(),
    raw,
  } as UnifiedCourse;
}

describe('snapshot raw 白名单', () => {
  it('保留超星后续请求必需的 classId / cpi / enc', async () => {
    const store = new MemoryStore();
    await store.init();
    await store.upsertCourses([
      makeCourse({ classId: '152728914', cpi: '487116507', enc: 'b2090525825', squareUrl: 'https://x' }),
    ]);

    const snap = store.snapshot();
    const raw = (snap.courses[0]?.raw ?? {}) as Record<string, unknown>;
    assert.equal(raw.classId, '152728914', 'classId 丢了 → 作业列表会回「无效的用户！」');
    assert.equal(raw.cpi, '487116507', 'cpi 丢了 → 作业/考试列表参数不全');
    assert.equal(raw.enc, 'b2090525825', 'enc 丢了 → 拿不到 stuenc');
  });

  it('仍然裁掉无关的大字段（snapshot 体积不能被 raw 拖爆）', async () => {
    const store = new MemoryStore();
    await store.init();
    await store.upsertCourses([
      makeCourse({
        classId: '1',
        // 模拟平台原始响应里的巨型字段
        courseOpenDtos: Array.from({ length: 50 }, (_, i) => ({ i, blob: 'x'.repeat(500) })),
        somethingHuge: 'y'.repeat(20_000),
      }),
    ]);

    const snap = store.snapshot();
    const raw = (snap.courses[0]?.raw ?? {}) as Record<string, unknown>;
    assert.equal(raw.classId, '1');
    assert.equal(raw.courseOpenDtos, undefined, '巨型字段必须被裁掉');
    assert.equal(raw.somethingHuge, undefined, '巨型字段必须被裁掉');
  });

  it('落盘→恢复一轮后 classId 仍在（这才是真机出问题的路径）', async () => {
    const store = new MemoryStore();
    await store.init();
    await store.upsertCourses([makeCourse({ classId: '152728914', cpi: '487116507', enc: 'e1' })]);

    const snap = store.snapshot();
    const restored = MemoryStore.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    const courses = await restored.listCourses(['chaoxing::a1']);
    const raw = (courses[0]?.raw ?? {}) as Record<string, unknown>;
    assert.equal(raw.classId, '152728914', '恢复后必须还能拿到 classId');
    assert.equal(raw.enc, 'e1');
  });
});
