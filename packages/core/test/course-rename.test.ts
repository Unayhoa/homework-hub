/**
 * 课程改名与「手动作业归并」。
 *
 * 核心不变量：**`name` 是数据键，`displayName` 才是给人看的**。
 * 所以改名只动后者 —— 一旦写进 name，下次同步就会被平台写回，
 * 而且历史记录（变更历史里的 course 字段）会对不上。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdapterRegistry,
  EncryptedVault,
  MemoryStore,
  StaticKeyProvider,
  SyncEngine,
  createSilentLogger,
  courseTitle,
  systemClock,
} from '../src/index.ts';
import type { HttpClient, UnifiedCourse } from '../src/index.ts';

const noHttp: HttpClient = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async request() {
    throw new Error('本测试不发请求');
  },
};

async function makeEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'hub-rename-'));
  const store = new MemoryStore();
  await store.init();
  const vault = new EncryptedVault({
    directory: join(dir, 'sessions'),
    keyProvider: new StaticKeyProvider('test-key'),
  });
  const engine = new SyncEngine({
    registry: new AdapterRegistry(),
    store,
    vault,
    http: noHttp,
    clock: systemClock,
    logger: createSilentLogger(),
  });
  return { dir, store, engine };
}

const course = (id: string, name: string, accountId = 'chaoxing::u1'): UnifiedCourse => ({
  id,
  platformId: 'chaoxing',
  accountId,
  platformCourseId: id,
  name,
  lastSeenAt: new Date().toISOString(),
});

describe('课程改名', () => {
  it('只改 displayName，平台原名 name 保持不动', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertCourses([course('c1', '高等数学')]);
      const r = await engine.renameCourse('c1', '高数（上）');
      assert.equal(r.ok, true);
      const [c] = await store.listCourses();
      assert.equal(c!.name, '高等数学', '数据键不能改 —— 改了下次同步会被平台写回');
      assert.equal(c!.displayName, '高数（上）');
      assert.equal(courseTitle(c!), '高数（上）');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('重名不拒绝：照常改名，只是把冲突报回去', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertCourses([course('c1', '高等数学'), course('c2', '数据结构')]);
      const r = await engine.renameCourse('c2', '高等数学');
      assert.equal(r.ok, true, '同名课各有 ID，本来就能并存');
      assert.equal(r.conflict?.id, 'c1');
      const courses = await store.listCourses();
      assert.equal(courses.filter((c) => courseTitle(c) === '高等数学').length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('跨账号不误报：两个学校都有「高等数学」很正常', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertCourses([course('a', '高等数学', 'chaoxing::u1'), course('b', '数据结构', 'chaoxing::u2')]);
      const r = await engine.renameCourse('b', '高等数学');
      assert.equal(r.conflict, undefined, '别的账号的同名课不算冲突');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('传空名 = 恢复平台原名', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertCourses([course('c1', '高等数学')]);
      await engine.renameCourse('c1', '高数');
      await engine.renameCourse('c1', '');
      const [c] = await store.listCourses();
      assert.equal(c!.displayName, undefined);
      assert.equal(courseTitle(c!), '高等数学');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('手动作业归并（重名的真正解法）', () => {
  it('把同名的手动任务归到课程 ID 下，之后按课程筛选就能一起出来', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertCourses([course('c1', '高等数学')]);
      const t = await engine.createManualTask({
        title: '手写作业',
        deadlineAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        courseName: '高等数学',
      });
      // 建的时候名字唯一匹配 → 已经自动归到 c1，不需要再手动归并
      assert.equal(t.courseId, 'c1');

      const r = await engine.adoptManualTasks('c1');
      assert.equal(r.moved, 0, '已经归好了，重复调用是幂等的');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('名字对不上任何课程时，手动任务用自己的课程名当 courseId（不硬塞）', async () => {
    const { dir, store, engine } = await makeEngine();
    try {
      await store.upsertCourses([course('c1', '高等数学')]);
      const t = await engine.createManualTask({
        title: '线下交的',
        deadlineAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        courseName: '形势与政策',
      });
      assert.notEqual(t.courseId, 'c1');
      assert.match(t.courseId, /形势与政策/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
