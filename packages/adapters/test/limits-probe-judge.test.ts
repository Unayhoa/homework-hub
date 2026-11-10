/**
 * 超星查询能力测试的「判据」必须可靠。
 *
 * 这个面板的全部价值在于「它能判断出平台是否在拦我们」。判据错了，
 * 得出的上限就是假的 —— 比没有数据更糟（会据此调高默认速率）。
 *
 * 真机已知的拦截形态（2026-11-10 实测）：
 *   · HTTP 403 + 正文 `<!doctype html>` + no-cache meta（通用拒绝页）
 *   · HTTP 200 + 正文「提示 无效的用户！」+ 1148 字节（参数/会话被拒）
 * 正常列表页特征：含 goTask / overHidden2 / bottomList，长度 19KB+。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeResponse } from '../../../apps/web/src/limits-probe.ts';

const NORMAL_LIST = `<ul class="bottomList"><li onclick="goTask(this);" data="...">${'x'.repeat(20000)}</ul>`;

describe('超星能力测试判据', () => {
  it('正常列表页 → 不拦', () => {
    assert.equal(judgeResponse(200, NORMAL_LIST).blocked, false);
  });

  it('HTTP 403 → 拦', () => {
    const v = judgeResponse(403, '<!doctype html><html></html>');
    assert.equal(v.blocked, true);
    assert.match(v.reason ?? '', /403/);
  });

  it('HTTP 429 → 拦（限流）', () => {
    assert.equal(judgeResponse(429, '').blocked, true);
  });

  it('200 + 「无效的用户」→ 拦（真机出现过的软拒绝）', () => {
    const v = judgeResponse(200, '<html><body>提示 无效的用户！</body></html>');
    assert.equal(v.blocked, true);
    assert.match(v.reason ?? '', /无效的用户/);
  });

  it('200 + 验证码 → 拦', () => {
    assert.equal(judgeResponse(200, '<html>请完成安全验证 滑动验证</html>').blocked, true);
  });

  it('200 + 无列表特征 → 拦（拿到错误页/空壳）', () => {
    const v = judgeResponse(200, '<html><body>something else entirely</body></html>');
    assert.equal(v.blocked, true);
    assert.match(v.reason ?? '', /列表特征/);
  });

  it('200 + 响应过短 → 拦（正常列表页 19KB+）', () => {
    const v = judgeResponse(200, '<ul class="bottomList"></ul>');
    assert.equal(v.blocked, true);
    assert.match(v.reason ?? '', /过短/);
  });

  it('500 → 拦（服务端异常也是不安全信号）', () => {
    assert.equal(judgeResponse(500, 'oops').blocked, true);
  });
});
