/**
 * 生产平台注册表（**不含 mock**）。
 *
 * 为什么和 index.ts 分开：mock 适配器依赖 node:http（它要在本机起一个假平台），
 * 而 Android WebView 的模块图里不能出现 node: 引用 —— 一旦出现，
 * 失败发生在加载阶段（白屏），而不是调用阶段。
 *
 * 所以浏览器端只引这个文件，index.ts 留给桌面/CLI（需要 mock 联调）。
 */
import { AdapterRegistry } from '#core/ports/registry.ts';
import { ChaoxingAdapter } from './chaoxing/src/index.ts';
import { YuketangAdapter } from './yuketang/src/index.ts';
import { IsmartAdapter } from './ismart/src/index.ts';
import { PintiaAdapter } from './pintia/src/index.ts';

/**
 * 注册所有真实平台适配器。
 *
 * 注意三个都是 experimental：接口路径来自社区公开信息，
 * 需要用真实账号逐条验证后再启用。先注册进来，
 * 让 UI 能展示能力矩阵，也让用户能真的去试。
 */
export function createProductionRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ChaoxingAdapter());
  // 雨课堂主站（www.yuketang.cn）不注册 —— 用户只用长江部署（changjiang.yuketang.cn），
  // 两个都列出来时容易点错，而且主站的作业模型不同（课次而非作业），实测不可用。
  // 适配器本体保留，将来要恢复只需放开下面一行。
  // registry.register(new YuketangAdapter());
  // 长江雨课堂是独立部署，id 会自动变成 yuketang-changjiang
  registry.register(new YuketangAdapter({ baseUrl: 'https://changjiang.yuketang.cn' }));
  registry.register(new IsmartAdapter());
  // PTA（拼题A）：字段与状态判定来自 2026-10-22 真机抓包，见适配器文件头
  registry.register(new PintiaAdapter());
  return registry;
}
