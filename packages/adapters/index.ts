/**
 * 适配器统一出口与默认注册表（桌面 / CLI 用，含 mock）。
 *
 * 抽到这里而不是留在 CLI 里，是因为不同壳层都需要同一份「支持哪些平台」的清单。
 *
 * ⚠️ 浏览器端（Android）请引 registry.ts —— 那份不含 mock。
 * mock 适配器依赖 node:http（它要在本机起一个假平台），
 * 一旦进了 WebView 的模块图，失败会发生在**加载阶段**（白屏），
 * 而不是调用阶段 —— 那是最难排查的一类问题。
 */
import { AdapterRegistry } from '#core/ports/registry.ts';
import { createProductionRegistry } from './registry.ts';
import { MockAdapter } from './mock/src/index.ts';
import { ChaoxingAdapter } from './chaoxing/src/index.ts';
import { YuketangAdapter } from './yuketang/src/index.ts';
import { IsmartAdapter } from './ismart/src/index.ts';
import { MockPlatform, createFixtures } from './mock/src/index.ts';

export {
  createProductionRegistry,
  ChaoxingAdapter,
  YuketangAdapter,
  IsmartAdapter,
  MockAdapter,
  MockPlatform,
  createFixtures,
};
export { ChaoxingEndpoints } from './chaoxing/src/index.ts';
export type { ChaoxingEndpointMap } from './chaoxing/src/index.ts';
export { YuketangEndpoints } from './yuketang/src/index.ts';
export type { YuketangEndpointMap } from './yuketang/src/index.ts';
export { SmartEndpoints } from './ismart/src/index.ts';
export type { SmartEndpointMap } from './ismart/src/index.ts';
export type {
  MockMode,
  MockTask,
  MockCourse,
  MockAccount,
  MockPlatformOptions,
  MockState,
} from './mock/src/index.ts';

export interface DefaultRegistryOptions {
  /**
   * 注册本地 Mock 平台（仅开发/联调用）。
   * 生产环境不要开 —— mock 适配器会让 UI 上多出一个不存在的平台。
   */
  mockBaseUrl?: string;
}

/** 生产平台 + 可选的本地 mock。 */
export function createDefaultRegistry(opts: DefaultRegistryOptions = {}): AdapterRegistry {
  const registry = createProductionRegistry();
  if (opts.mockBaseUrl) registry.register(new MockAdapter({ baseUrl: opts.mockBaseUrl }));
  return registry;
}
