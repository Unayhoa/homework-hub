/**
 * 故障接收器与修复包。
 *
 * 这个文件守三条线：
 *   1. **AI 修不了的故障，一个字节都不发给它**（会话失效、签名参数）。
 *      发过去只会得到一段看起来合理、跑起来无效的解释，用户还以为自己配置错了。
 *   2. **发给 AI 的材料里不能出现作业内容**。只要它看得见标题，它就会去"提取作业"
 *      而不是"写读取规则"（adapter-authoring.ts 里记着这次实测）。材料脱敏不能靠自觉，
 *      要有测试钉住。
 *   3. 每份修复包必须自包含：粘到任何免费模型的对话框里就能用，不需要用户补充背景。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFixPack, classifyFailure, kindOfCode, structureOf, summarizeSamples } from '../src/engine/diagnostics.ts';
import { HubError } from '../src/index.ts';
import { analyzeSamples } from '../src/engine/probe.ts';

const ORIGIN = 'https://zhihuishu.example.edu';

describe('故障归类：只看错误码，不看文案', () => {
  it('code → 修复策略', () => {
    assert.equal(kindOfCode('AUTH_REQUIRED'), 'auth');
    assert.equal(kindOfCode('CAPTCHA_REQUIRED'), 'auth');
    assert.equal(kindOfCode('SIGNATURE_REQUIRED'), 'signature');
    assert.equal(kindOfCode('NETWORK'), 'network');
    assert.equal(kindOfCode('RATE_LIMITED'), 'network');
    assert.equal(kindOfCode('PARSE_EMPTY'), 'trial-empty');
    assert.equal(kindOfCode('UPSTREAM'), 'trial-failed');
    assert.equal(kindOfCode('SELECTOR_STALE'), 'dom-selector');
    assert.equal(kindOfCode('PROBE_EMPTY'), 'probe-empty');
    assert.equal(kindOfCode('COURSE_MISMATCH'), 'course-mismatch');
  });

  it('认不出就 unknown（走保守路径，不要瞎猜成"AI 能修"）', () => {
    assert.equal(kindOfCode(undefined), 'unknown');
    assert.equal(kindOfCode('WHATEVER'), 'unknown');
    assert.equal(classifyFailure(undefined), 'unknown');
  });

  it('改文案不会改变分类 —— 这一步就是要防"文案一改分类静默漂移"', () => {
    const a = new HubError('AUTH_REQUIRED', '会话已过期，请重新登录');
    const b = new HubError('AUTH_REQUIRED', '登录态失效');
    const c = new HubError('AUTH_REQUIRED', 'whatever the wording becomes');
    for (const e of [a, b, c]) assert.equal(classifyFailure(e), 'auth');
  });

  it('只有 message 没有 code 的错误一律 unknown，绝不当成"AI 能修"', () => {
    const e = new Error('作业列表取不到（listPath「$.data」没命中）');
    assert.equal(classifyFailure(e), 'unknown');
  });
});

describe('修复包：AI 修不了的，不给 AI 包', () => {
  it('会话失效 → 只给"去重新登录"，没有复制按钮', () => {
    const p = buildFixPack({ code: 'AUTH_REQUIRED', error: 'AUTH_REQUIRED', origin: ORIGIN, platformName: '智慧树' });
    assert.equal(p.aiCanFix, false);
    assert.ok(!p.actions.some((a) => a.kind === 'copy'), '不要给用户一个"发给 AI"的按钮去解决会话问题');
    assert.equal(p.actions[0]!.kind, 'open');
    // 文案不能出现技术名词：用户要做的是"重新登录"，不是"会话过期"
    assert.ok(!/AUTH|会话|token/i.test(p.headline), `headline 太技术了：${p.headline}`);
  });

  it('签名参数 → 引导改走 DOM，不给 AI 包', () => {
    const p = buildFixPack({ code: 'SIGNATURE_REQUIRED', origin: ORIGIN, platformName: '智慧树' });
    assert.equal(p.aiCanFix, false);
    assert.ok(!p.actions.some((a) => a.kind === 'copy'));
    assert.ok(p.nextStep.includes('点选'), `应引导改走页面点选，实际：${p.nextStep}`);
  });

  it('最多两个动作 —— 多了用户就不选了', () => {
    for (const code of ['PROBE_EMPTY', 'PARSE_EMPTY', 'UPSTREAM', 'SELECTOR_STALE', 'COURSE_MISMATCH', 'UNKNOWN'] as const) {
      const p = buildFixPack({ code, error: 'x', platformName: 'P', origin: ORIGIN });
      assert.ok(p.actions.length <= 2, `${code} 给了 ${p.actions.length} 个动作`);
    }
  });
});

describe('修复包：材料必须脱敏且自包含', () => {
  const SAMPLES = [
    {
      url: `${ORIGIN}/api/homework/list?page=1`,
      body: JSON.stringify({
        data: {
          list: [
            { id: 1001, name: '第一章 同余方程习题（机密作业标题）', endTime: '2025-12-07 23:25', courseName: '信息安全数学基础' },
            { id: 1002, name: '第二章 二次剩余', endTime: '2025-12-08 23:25', courseName: '信息安全数学基础' },
          ],
        },
      }),
    },
  ];

  it('结构摘要不泄漏作业标题', () => {
    const s = structureOf(SAMPLES[0]!.body, 1);
    assert.ok(!s.includes('同余方程'), '结构里出现了作业标题 —— AI 会去提取作业而不是写规则');
    assert.ok(s.includes('name'), '结构必须保留字段名，否则 AI 无从填 path');
    assert.ok(/<string len=\d+>/.test(s), '值应被替换成占位符');
  });

  it('summarizeSamples 保留 URL（配置里要填它）但同样脱敏', () => {
    const s = summarizeSamples(SAMPLES);
    assert.ok(s.includes('/api/homework/list'), 'URL 必须留着，否则 AI 没法填 tasks.url');
    assert.ok(!s.includes('二次剩余'));
  });

  it('「没认出接口」的包的素材里不含作业正文，且要求只输出 JSON', () => {
    const p = buildFixPack({ code: 'PROBE_EMPTY', samples: SAMPLES, platformName: '智慧树', origin: ORIGIN });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(payload.includes('只输出 JSON'));
    assert.ok(!payload.includes('同余方程'), '素材泄漏了作业内容');
    assert.ok(payload.includes(ORIGIN), '材料要自包含：站点地址必须在里面');
  });

  it('修路径的包里带着当前配置（AI 才能只改错处）', () => {
    const cfg = { key: 'x', name: '智慧树', origin: ORIGIN, tasks: { url: 'u', listPath: '$.wrong' }, fields: {} };
    const p = buildFixPack({ code: 'PARSE_EMPTY', error: 'listPath「$.wrong」没命中', config: cfg, samples: SAMPLES, platformName: '智慧树' });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(payload.includes('$.wrong'), '必须带原配置，否则 AI 会从头重写、把对的部分也改掉');
    assert.ok(payload.includes('只改错的地方'), '提示词必须明确"只改错处"');
  });

  it('URL 里的 token 必须脱敏 —— 材料是要发给外部 AI 的', () => {
    // 真实场景：平台自己拼的地址带 ?token=xxx&sign=yyy，录制原样存下来。
    // 老路径（Java 的 buildMarkdown）会脱敏，新路径如果在各处拼装时忘了，就是凭据外泄。
    const leaky = [
      { url: `${ORIGIN}/api/task?token=SECRET123&sign=abc&page=1`, body: '{"data":[{"title":"x","endTime":"2025-12-07 23:25"}]}' },
    ];
    const p = buildFixPack({ code: 'PROBE_EMPTY', samples: leaky, platformName: 'P', origin: ORIGIN });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(!payload.includes('SECRET123'), 'token 泄漏到了给 AI 的材料里');
    assert.ok(!payload.includes('sign=abc'), 'sign 泄漏到了给 AI 的材料里');
    assert.ok(payload.includes('page=1'), '非敏感参数不该被一起抹掉（否则 AI 判断不出分页）');
  });

  it('配置里带 token 的地址同样脱敏', () => {
    const cfg = { tasks: { url: `${ORIGIN}/x?token=SECRET999`, listPath: '$.a' } };
    const p = buildFixPack({ code: 'PARSE_EMPTY', error: 'e', config: cfg, platformName: 'P' });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(!payload.includes('SECRET999'));
  });
});

describe('探查失败时的闭环：分析 → 修复包', () => {
  it('样本全是菜单/用户信息 → 给"挑接口"包，而不是空白', () => {
    const r = analyzeSamples([
      { url: `${ORIGIN}/api/user`, body: JSON.stringify({ data: { userId: 1, nick: '张三' } }) },
    ]);
    assert.equal(r.tasks.length, 0);
    const p = buildFixPack({ code: 'PROBE_EMPTY', samples: [{ url: `${ORIGIN}/api/user`, body: '{"data":{"userId":1}}' }], platformName: 'P', origin: ORIGIN });
    assert.equal(p.aiCanFix, true);
    assert.ok(p.actions.some((a) => a.kind === 'copy'));
  });
});

describe('脱敏：参数名的变体也是凭据（超星真机反例）', () => {
  it('appAuthToken / authToken / accessToken / apiKey 都要打码', () => {
    // 真机反例（2026-10-27）：超星样本里出现
    //   ?courseId=...&appId=...&appAuthToken=b8336ee4b154ba8fabe630ee51e1ec54
    // 它既不是 token 也不是 auth，精确匹配全漏了 —— 而它确实是一个凭据。
    const p = buildFixPack({
      code: 'PROBE_EMPTY',
      samples: [
        {
          url: 'https://robot-lc.chaoxing.com/v1/api/robot/course/getRobotId?courseId=201764055&appAuthToken=b8336ee4b154ba8fabe630ee51e1ec54',
          body: '{"statusCode":0,"data":{"robotId":"x"}}',
        },
        { url: 'https://x.edu/a?authToken=AAA111&apiKey=BBB222&page=2', body: '{"data":[]}' },
      ],
      platformName: '超星',
      origin: 'https://mooc2-ans.chaoxing.com',
    });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(!payload.includes('b8336ee4b154ba8fabe630ee51e1ec54'), 'appAuthToken 泄漏');
    assert.ok(!payload.includes('AAA111'), 'authToken 泄漏');
    assert.ok(!payload.includes('BBB222'), 'apiKey 泄漏');
    assert.ok(payload.includes('page=2'), '非敏感参数不该被抹（否则看不出分页）');
  });
});

describe('「认不出」的两种原因，建议必须相反', () => {
  // 真机（2026-10-27，超星）：页面能看见作业，但发出的 JSON 全是 AI 助手/配置，
  // 一个数组都没有。此时让他"再翻一遍作业列表"是白费力气 —— 翻多少次都不会出现接口。
  it('一个数组都没出现 → 直接引导页面点选，不给"再试一次"', () => {
    const p = buildFixPack({
      code: 'PROBE_EMPTY',
      platformName: '超星学习通',
      origin: 'https://mooc2-ans.chaoxing.com',
      noJsonList: true,
    });
    assert.equal(p.aiCanFix, false, '数据不在接口里，AI 改配置也救不了');
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0]!.id, 'use-dom', '唯一出路是改用页面点选');
    assert.ok(!p.actions.some((a) => a.kind === 'copy'), '不要给"复制给 AI"——它没法让 HTML 变成接口');
    assert.ok(/不在接口里|页面/.test(p.headline));
  });

  it('出现过数组但都不像列表 → 仍然让他再采一次（可能是页面没翻到）', () => {
    const p = buildFixPack({ code: 'PROBE_EMPTY', platformName: 'P', origin: 'https://x.edu' });
    assert.equal(p.aiCanFix, true);
    assert.ok(p.actions.some((a) => a.id === 'recollect'));
  });
});
