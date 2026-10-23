/**
 * iSmart 适配器解析测试 —— 夹具直接取自 2026-09-27 的真实抓包（HAR）。
 * 平台字段若再变版，用新抓包替换这里的 JSON 即可定位差异。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseSmartCourses, parseSmartTests, IsmartAdapter } from '../ismart/src/index.ts';

// ---- 真实抓包片段（school.ismartlearning.cn/client/course/list-of-student）----
const COURSE_LIST = [
  {
    courseCode: '290987',
    courseId: 124039,
    courseName: '26-27秋季学术英语三班',
    courseType: 1,
    lecturerName: '夏文静',
    status: 1,
    subjectId: 1192,
    teacherName: '夏文静',
  },
  {
    courseCode: '237059',
    courseId: 114485,
    courseName: '25秋B425植物12节',
    courseType: 1,
    teacherName: '杨敏',
  },
];

// ---- 真实抓包片段（/client/homework/tests/list-of-student，testStatus=0 与 1 各一条）----
const TEST_RUNNING = {
  test_name: 'Watch Minilecture2, U5, fill in following blanks.',
  test_id: '16E89E8C91922785C6D4E271C5EF731E',
  test_type: 2,
  testStatus: 0,
  stustatus: 0,
  status: 2,
  // 2026-10-08 20:00 +08:00 —— 与平台界面显示的截止时间一致
  end_time: 1791460800000,
  begin_time: 1789717200000,
};
const TEST_FINISHED = {
  test_name: 'Watch Minilecture1, U5, fill in following blanks.',
  test_id: 'BBBE668959EF00DB405B6F450DD19C10',
  test_type: 2,
  testStatus: 1,
  stustatus: 3,
  status: 2,
  end_time: 1789646400000,
  begin_time: 1789084800000,
  score: 10,
};

describe('ismart · parseSmartCourses（真实抓包夹具）', () => {
  it('解析课程 ID / 名称 / 教师', () => {
    const courses = parseSmartCourses(COURSE_LIST);
    assert.equal(courses.length, 2);
    assert.equal(courses[0]!.platformCourseId, '124039');
    assert.equal(courses[0]!.name, '26-27秋季学术英语三班');
    assert.equal(courses[0]!.teacher, '夏文静');
  });

  it('缺 courseId 或 courseName 的行被跳过', () => {
    const courses = parseSmartCourses([{ foo: 1 }, { courseId: 1 }, ...COURSE_LIST]);
    assert.equal(courses.length, 2);
  });
});

describe('ismart · parseSmartTests（真实抓包夹具）', () => {
  it('进行中 + 未做 → pending，截止时间为 epoch 毫秒转 ISO', () => {
    const items = parseSmartTests([TEST_RUNNING], '124039', '学术英语');
    assert.equal(items.length, 1);
    const t = items[0]!;
    assert.equal(t.platformTaskId, '16E89E8C91922785C6D4E271C5EF731E');
    assert.equal(t.status, 'pending');
    assert.equal(t.kind, 'quiz');
    assert.equal(t.deadline, new Date(1791460800000).toISOString());
    assert.equal(new Date(t.deadline!).getHours() >= 0, true);
  });

  it('已结束 + 已完成（stustatus=3）→ submitted，带分数', () => {
    const items = parseSmartTests([TEST_FINISHED], '124039', '学术英语');
    assert.equal(items[0]!.status, 'submitted');
    assert.equal(items[0]!.score, 10);
  });

  it('已结束 + 未做 → expired（错过了）', () => {
    const items = parseSmartTests([{ ...TEST_RUNNING, testStatus: 1, stustatus: 0 }], '1', 'x');
    assert.equal(items[0]!.status, 'expired');
  });

  it('test_type 非 2 归为 homework', () => {
    const items = parseSmartTests([{ ...TEST_RUNNING, test_type: 1 }], '1', 'x');
    assert.equal(items[0]!.kind, 'homework');
  });
});

describe('ismart · 适配器装配', () => {
  it('签名声明已按抓包结论关闭，能力与只读策略正确', () => {
    const a = new IsmartAdapter();
    assert.equal(a.capabilities.requiresNativeSigner, false, '抓包证实网页端接口无需签名');
    assert.equal(a.capabilities.cookieOnlySession, true);
    assert.equal(
      a.readOnlyPolicy.allowPost?.some((p) => p.pattern instanceof RegExp && p.pattern.source.includes('currentuser')),
      true,
    );
  });

  it('账号密码登录已实现（SSO 协议逆向），但缺凭据时明确报错', async () => {
    const a = new IsmartAdapter();
    await assert.rejects(
      () => a.login({ clock: { now: () => new Date(), nowMs: () => Date.now() } } as never, {}),
      /需要账号和密码/,
    );
  });

  it('MD5 实现与已知向量一致（登录协议依赖它）', async () => {
    const { md5 } = await import('../ismart/src/md5.ts');
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(md5('123456'), 'e10adc3949ba59abbe56e057f20f883e');
    assert.equal(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
  });

  it('只读放行规则必须匹配带查询串的 URL（真机踩过：?status=1 让 $ 锚点失配 → 请求被拦）', () => {
    const a = new IsmartAdapter();
    const cases = [
      'https://school.ismartlearning.cn/client/course/list-of-student?status=1',
      'https://school.ismartlearning.cn/client/homework/tests/list-of-student',
      'https://school.ismartlearning.cn/client/user/currentuser',
    ];
    for (const url of cases) {
      const hit = a.readOnlyPolicy.allowPost?.some(
        (p) => p.pattern instanceof RegExp && p.pattern.test(url),
      );
      assert.equal(hit, true, `放行规则应匹配 ${url}`);
    }
  });
});

// ---------------------------------------------------------------- 换票取证（A'）

const SCHOOL = 'https://school.ismartlearning.cn';
const SSO = 'https://sso.ismartlearning.cn';

/**
 * 只回固定响应的 HTTP 桩：按 URL 分流（换票走 /login，探活走 currentuser）。
 *
 * exchange = 'throw' 模拟请求本身发不出去；
 * probeData 是探活接口 data 字段的内容（有 uid = 会话还活着）。
 */
function stubCtx(exchange: unknown, probeData: Record<string, unknown>) {
  const http = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async request(req: { url: string }) {
      let status = 200;
      let finalUrl = req.url;
      let text = '';
      if (req.url.includes('/login')) {
        if (exchange === 'throw') throw new Error('网络不通');
        const ex = exchange as { status?: number; url?: string; text?: string };
        status = ex.status ?? 302;
        finalUrl = ex.url ?? req.url;
        text = ex.text ?? '';
      } else {
        text = JSON.stringify({ result: { code: 0 }, data: probeData });
      }
      return {
        status,
        headers: {},
        url: finalUrl,
        setCookies: [],
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
        bytes: async () => new Uint8Array(),
      };
    },
  };
  return { http } as never;
}

const session = {
  platformId: 'ismart',
  accountId: 'ismart::browser',
  cookies: {},
  headers: {},
  issuedAt: new Date().toISOString(),
};

/**
 * 自动接回为什么失败，有两种**下一步完全相反**的原因。
 * 以前只回一句「自动续登未成功（总票据可能也已过期）」，等于把判断留给了猜：
 * 不区分的话，我们没法决定"还要不要继续修这条路"。
 */
describe('ismart · 自动接回失败的换票取证', () => {
  it('换票被退回登录页 → ticket-expired（平台策略，App 侧没有可修入口）', async () => {
    const a = new IsmartAdapter();
    const r = await a.recoverSession!(
      stubCtx({ status: 200, url: `${SSO}/login?service=x`, text: '<input type="password">' }, {}),
      session,
    );
    assert.equal(r.recovered, false);
    assert.equal(r.diagnosis, 'ticket-expired');
    assert.match(r.note ?? '', /退回登录页/);
    // 措辞要明确这是平台策略、需要重登一次，而不是把责任推给用户
    assert.match(r.note ?? '', /重新登录一次/);
  });

  it('票换到了、本域却不认 → mechanism（这条路本身是坏的，值得继续修）', async () => {
    const a = new IsmartAdapter();
    const r = await a.recoverSession!(stubCtx({ status: 200, url: `${SCHOOL}/` }, {}), session);
    assert.equal(r.recovered, false);
    assert.equal(r.diagnosis, 'mechanism');
    assert.match(r.note ?? '', /换票这一步是成功的/);
    // 必须说清"不是总票据过期"，否则我们会往错误方向投入
    assert.match(r.note ?? '', /不是总票据过期/);
  });

  it('换票请求本身发不出去 → channel（别再怀疑票据）', async () => {
    const a = new IsmartAdapter();
    const r = await a.recoverSession!(stubCtx('throw', {}), session);
    assert.equal(r.recovered, false);
    assert.equal(r.diagnosis, 'channel');
    assert.match(r.note ?? '', /换票请求本身没发成/);
  });

  it('接回成功 → recovered，不留下任何需要用户处理的痕迹', async () => {
    const a = new IsmartAdapter();
    const r = await a.recoverSession!(stubCtx({ status: 200, url: `${SCHOOL}/` }, { uid: 42 }), session);
    assert.equal(r.recovered, true);
    assert.equal(r.diagnosis, 'recovered');
  });

  it('判据用「最终落在哪个域」，不依赖 Set-Cookie（原生桥刻意不回传它）', async () => {
    const a = new IsmartAdapter();
    // 换到票：最终 URL 落在 school 域。就算 body 里恰好含 password 字样也不能误判
    const r = await a.recoverSession!(
      stubCtx({ status: 200, url: `${SCHOOL}/center/student/index.html`, text: 'password' }, {}),
      session,
    );
    assert.equal(r.diagnosis, 'mechanism');
  });
});

describe('ismart · 保活探测声明', () => {
  it('指向最便宜的探活接口，且间隔不短于 15 分钟（不能变成高频轮询）', () => {
    const p = new IsmartAdapter().keepAliveProbe;
    assert.match(p.url, /\/client\/user\/currentuser$/);
    assert.equal(p.method, 'POST');
    assert.ok(p.intervalMs >= 15 * 60 * 1000, `间隔 ${p.intervalMs}ms 短于 15 分钟`);
  });

  it('alivePattern 能区分「会话有效」与「返回登录页」', () => {
    const re = new RegExp(new IsmartAdapter().keepAliveProbe.alivePattern);
    assert.equal(re.test('{"result":{"code":0},"data":{"uid":12345}}'), true);
    assert.equal(re.test('<html><input type="password" id="pwd"></html>'), false);
  });

  it('失效归因按可能性排序：闲置超时在前，异地登录在后', () => {
    const causes = new IsmartAdapter().sessionExpiryCauses!;
    assert.ok(causes.length >= 2);
    assert.match(causes[0]!, /闲置/);
    assert.match(causes[causes.length - 1]!, /别处登录/);
  });
});
