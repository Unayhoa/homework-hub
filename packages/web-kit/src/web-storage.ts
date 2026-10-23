/**
 * 浏览器端（WebView）可用的键值存储抽象。
 *
 * Android WebView 里没有 node:fs，所以 desktop 的 JsonFileStore 用不了。
 * 这里把「往哪存」抽象成 WebStorage，实现有两个：
 *   - localStorage（WebView 自带，落在应用私有目录）
 *   - Android 桥（走原生文件，容量更大、更可控）
 */
export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** 列出全部键，用于 Vault 的 list() */
  keys(): string[];
}

/** 把 window.localStorage 适配成 WebStorage（补一个 keys()）。 */
export function localStorageAdapter(ls: Storage): WebStorage {
  return {
    getItem: (k) => ls.getItem(k),
    setItem: (k, v) => ls.setItem(k, v),
    removeItem: (k) => ls.removeItem(k),
    keys: () => {
      const out: string[] = [];
      for (let i = 0; i < ls.length; i += 1) {
        const k = ls.key(i);
        if (k) out.push(k);
      }
      return out;
    },
  };
}

/**
 * 内存兜底实现。WebView 隐私模式、或桥不可用时用它 ——
 * 至少让 App 能跑起来（数据不持久），而不是白屏。
 */
export function memoryStorage(): WebStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

// ---------------------------------------------------------------- 原生文件存储

/** 原生键值存储桥（Android 的 HttpBridge 提供）。 */
export interface NativeKvBridge {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): boolean;
  kvRemove(key: string): boolean;
  /** 全部键名，换行分隔 */
  kvKeys(): string;
}

/**
 * 用原生文件存储实现 WebStorage。
 *
 * 为什么不用 localStorage（真机踩过，症状非常典型）：
 * WebView 的 localStorage 是「先写内存、由浏览器引擎择机刷盘」。
 * App 被从最近任务里划掉时进程直接被杀（拿不到正常的 onPause 时机），
 * **未刷盘的那部分数据就丢了** —— 表现是「同步后都显示正常，
 * 清除后台重进就少了最后同步的那个平台」。超星的 84 条正好是最后写入的一批。
 *
 * 原生侧是同步写文件 + fsync，写成功就是真的落盘了，不依赖任何时机。
 */
export function nativeKvStorage(bridge: NativeKvBridge): WebStorage {
  return {
    getItem: (k) => bridge.kvGet(k),
    setItem: (k, v) => {
      // 失败要抛出去，而不是静默 —— PersistentStore 会转交 onError，
      // 上层据此提示用户「数据没保存成功」。静默失败正是这个 bug 难查的原因。
      if (!bridge.kvSet(k, v)) throw new Error('原生存储写入失败（磁盘写入异常）');
    },
    removeItem: (k) => void bridge.kvRemove(k),
    keys: () => {
      const raw = bridge.kvKeys();
      if (!raw) return [];
      return raw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
  };
}
