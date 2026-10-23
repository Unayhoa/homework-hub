/**
 * 设置保存的语义 + 预设挡位的数值。
 *
 * 两个真机问题（2026-10-23）：
 *   1. 改每日汇总 → 再改提醒密度 → 每日汇总被打回默认。
 *      根因是保存走"整体替换"：只发改动项时，缺失字段被 normalize 填成默认值。
 *   2. 预设挡位的最后一次提醒落在 1 小时前 —— 那时才响，来不及做任何事。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFY_PRESETS,
  readNotifyPrefs,
  writeNotifyPrefs,
} from '../src/index.ts';

/** 极简内存存储，模拟原生 KV。 */
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe('设置保存是「部分更新」，不会互相覆盖', () => {
  it('改每日汇总 21:00 之后再去改提醒密度，21:00 必须留着', () => {
    const s = memStorage();
    writeNotifyPrefs(s, { dailyHour: 21 });
    assert.equal(readNotifyPrefs(s).dailyHour, 21);

    // 设置页改密度时只发 level（其它字段不在 patch 里）
    writeNotifyPrefs(s, { level: 'tight' });
    const after = readNotifyPrefs(s);
    assert.equal(after.level, 'tight');
    assert.equal(after.dailyHour, 21, '改密度不能把每日汇总打回默认 8:00');
  });

  it('反过来也一样：先改密度，再改每日汇总，密度不该被重置', () => {
    const s = memStorage();
    writeNotifyPrefs(s, { level: 'loose' });
    writeNotifyPrefs(s, { dailyHour: 7 });
    const after = readNotifyPrefs(s);
    assert.equal(after.level, 'loose', '改每日汇总不能把密度打回 standard');
    assert.equal(after.dailyHour, 7);
  });

  it('只改每日汇总开关，不动其他任何东西', () => {
    const s = memStorage();
    writeNotifyPrefs(s, { level: 'tight', dailyHour: 20, dailyDays: 5 });
    writeNotifyPrefs(s, { daily: false });
    const after = readNotifyPrefs(s);
    assert.equal(after.daily, false);
    assert.equal(after.level, 'tight');
    assert.equal(after.dailyHour, 20);
    assert.equal(after.dailyDays, 5);
  });

  it('区间与档位也互不影响', () => {
    const s = memStorage();
    writeNotifyPrefs(s, { level: 'tight' });
    writeNotifyPrefs(s, { task: { firstHours: 36, lastHours: 3, times: 2 } });
    const after = readNotifyPrefs(s);
    assert.equal(after.level, 'tight', '改区间不该把档位打回默认');
    assert.deepEqual(after.task, { firstHours: 36, lastHours: 3, times: 2 });
  });
});

describe('预设挡位：最后一次提醒落在 2 小时前', () => {
  it('标准与紧凑都是 2h（1h 太晚，来不及做任何事）', () => {
    for (const level of ['standard', 'tight'] as const) {
      assert.equal(NOTIFY_PRESETS[level].task.lastHours, 2, `${level} 作业`);
      assert.equal(NOTIFY_PRESETS[level].exam.lastHours, 2, `${level} 考试`);
    }
  });

  it('宽松档保持 12h / 24h —— 它本来就只有两次，跨度大是设计意图', () => {
    assert.equal(NOTIFY_PRESETS.loose.task.lastHours, 12);
    assert.equal(NOTIFY_PRESETS.loose.exam.lastHours, 24);
  });
});
