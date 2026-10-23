/**
 * 本地 Mock 教学平台（开发用）。
 *
 * 用途：在不碰真实账号的前提下开发/调试 UI 与适配器。
 *
 *   node scripts/mock-server.ts              # 默认 8792 端口
 *   node scripts/mock-server.ts --port 9000
 *
 * 然后让 Web App 挂上它（会多出一个「Mock 教学平台」）：
 *   HH_MOCK_URL=http://127.0.0.1:8792 node apps/web/src/server.ts
 *
 * 平台里预置了会「使坏」的数据形态（脏截止时间、无 ID 任务、
 * 已提交/已批阅、不限时），详见 packages/adapters/mock/src/fixtures.ts。
 * 故障注入（改版/限流/会话失效）见 MockPlatform 的 setMode / invalidateSessions，
 * 目前通过 demo 驱动；后续可以把控制面板做进 Web UI。
 */
import { MockPlatform, createFixtures } from '../packages/adapters/mock/src/index.ts';

const portFlag = process.argv.indexOf('--port');
const port = portFlag > 0 ? Number(process.argv[portFlag + 1] ?? 8792) : 8792;

const platform = new MockPlatform({
  port,
  ...createFixtures(new Date()),
  accounts: [{ username: '20230001', password: 's3cret', displayName: '张同学' }],
  pageSize: 4,
});
const url = await platform.start();
console.log(`[mock] 已启动 ${url} （账号 20230001 / s3cret，共 ${platform.state.taskCount} 条任务，每页 4 条）`);
console.log('[mock] Ctrl+C 退出');
setInterval(() => {}, 1 << 30);
