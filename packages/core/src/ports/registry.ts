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
