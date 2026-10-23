import type { PlatformAdapter } from './adapter.ts';

/** 适配器注册表。新增平台 = 注册一个适配器，engine 与 UI 代码零改动。 */
export class AdapterRegistry {
  #adapters = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): this {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`适配器 ${adapter.id} 已注册，请勿重复注册`);
    }
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  registerAll(adapters: PlatformAdapter[]): this {
    for (const a of adapters) this.register(a);
    return this;
  }

  /**
   * 注销一个适配器。
   *
   * 需要的场景只有一个：用户重新启用了同一份配置（修正版）。
   * 没有它，注册表里会一直留着旧实例 —— 用户改完配置点同步，行为还是旧的，
   * 表现为"我明明改了却没生效"。
   */
  unregister(id: string): boolean {
    return this.#adapters.delete(id);
  }

  get(id: string): PlatformAdapter | undefined {
    return this.#adapters.get(id);
  }

  require(id: string): PlatformAdapter {
    const a = this.#adapters.get(id);
    if (!a) throw new Error(`未找到平台适配器：${id}（已注册：${this.ids().join(', ') || '无'}）`);
    return a;
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  list(): PlatformAdapter[] {
    return [...this.#adapters.values()];
  }
}
