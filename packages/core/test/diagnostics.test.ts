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

import { buildFixPack, classifyFailure, structureOf, summarizeSamples } from '../src/engine/diagnostics.ts';
import { analyzeSamples } from '../src/engine/probe.ts';

const ORIGIN = 'https://zhihuishu.example.edu';

describe('故障归类：宁可 unknown，也不要瞎猜成"AI 能修"', () => {
  it('认得四类常见错误', () => {
    assert.equal(classifyFailure('AUTH_REQUIRED: 会话已过期'), 'auth');
    assert.equal(classifyFailure('请先登录后再访问'), 'auth');
    assert.equal(classifyFailure('接口需要 key={uuid} 参数'), 'signature');
    assert.equal(classifyFailure('作业列表取不到（listPath「$.data」没命中）'), 'trial-empty');
    assert.equal(classifyFailure('页面打开了，但一条作业都没抓到（选择器可能已失效）'), 'dom-selector');
  });

  it('认不出就 unknown', () => {
    assert.equal(classifyFailure('something odd happened'), 'unknown');
    assert.equal(classifyFailure(undefined), 'unknown');
  });
});

describe('修复包：AI 修不了的，不给 AI 包', () => {
  it('会话失效 → 只给"去重新登录"，没有复制按钮', () => {
    const p = buildFixPack({ kind: 'auth', error: 'AUTH_REQUIRED', origin: ORIGIN, platformName: '智慧树' });
    assert.equal(p.aiCanFix, false);
    assert.ok(!p.actions.some((a) => a.kind === 'copy'), '不要给用户一个"发给 AI"的按钮去解决会话问题');
    assert.equal(p.actions[0]!.kind, 'open');
    // 文案不能出现技术名词：用户要做的是"重新登录"，不是"会话过期"
    assert.ok(!/AUTH|会话|token/i.test(p.headline), `headline 太技术了：${p.headline}`);
  });

  it('签名参数 → 引导改走 DOM，不给 AI 包', () => {
    const p = buildFixPack({ kind: 'signature', origin: ORIGIN, platformName: '智慧树' });
    assert.equal(p.aiCanFix, false);
    assert.ok(!p.actions.some((a) => a.kind === 'copy'));
    assert.ok(p.nextStep.includes('点选'), `应引导改走页面点选，实际：${p.nextStep}`);
  });

  it('最多两个动作 —— 多了用户就不选了', () => {
    for (const kind of ['probe-empty', 'trial-empty', 'trial-failed', 'dom-selector', 'sync-failed', 'unknown'] as const) {
      const p = buildFixPack({ kind, error: 'x', platformName: 'P', origin: ORIGIN });
      assert.ok(p.actions.length <= 2, `${kind} 给了 ${p.actions.length} 个动作`);
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
    const p = buildFixPack({ kind: 'probe-empty', samples: SAMPLES, platformName: '智慧树', origin: ORIGIN });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(payload.includes('只输出 JSON'));
    assert.ok(!payload.includes('同余方程'), '素材泄漏了作业内容');
    assert.ok(payload.includes(ORIGIN), '材料要自包含：站点地址必须在里面');
  });

  it('修路径的包里带着当前配置（AI 才能只改错处）', () => {
    const cfg = { key: 'x', name: '智慧树', origin: ORIGIN, tasks: { url: 'u', listPath: '$.wrong' }, fields: {} };
    const p = buildFixPack({ kind: 'trial-empty', error: 'listPath「$.wrong」没命中', config: cfg, samples: SAMPLES, platformName: '智慧树' });
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
    const p = buildFixPack({ kind: 'probe-empty', samples: leaky, platformName: 'P', origin: ORIGIN });
    const payload = p.actions.find((a) => a.kind === 'copy')?.payload ?? '';
    assert.ok(!payload.includes('SECRET123'), 'token 泄漏到了给 AI 的材料里');
    assert.ok(!payload.includes('sign=abc'), 'sign 泄漏到了给 AI 的材料里');
    assert.ok(payload.includes('page=1'), '非敏感参数不该被一起抹掉（否则 AI 判断不出分页）');
  });

  it('配置里带 token 的地址同样脱敏', () => {
    const cfg = { tasks: { url: `${ORIGIN}/x?token=SECRET999`, listPath: '$.a' } };
    const p = buildFixPack({ kind: 'trial-empty', error: 'e', config: cfg, platformName: 'P' });
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
    const p = buildFixPack({ kind: 'probe-empty', samples: [{ url: `${ORIGIN}/api/user`, body: '{"data":{"userId":1}}' }], platformName: 'P', origin: ORIGIN });
    assert.equal(p.aiCanFix, true);
    assert.ok(p.actions.some((a) => a.kind === 'copy'));
  });
});
