/**
 * Native 签名桥端口。
 *
 * 这是本项目绕不开的一块硬骨头，必须提前抽象出来。
 *
 * 现实：iSmart 上报分数/提交答案的请求里有个 `ut` 字段，
 * 生成逻辑被编译进了原生 so/dll，JS 侧完全逆向不出来（社区结论：
 * 需要 unidbg 之类的模拟执行框架去跑那个 so）。智慧树也有类似的
 * JS 混淆 + SALT 拼接签名。这类东西用纯 TypeScript 做不了，
 * 硬做只会把整个项目锁死在某个平台。
 *
 * 所以架构上把「签名」抽成一个可替换的端口：
 *   - 有 native 实现的用户，挂上 SubprocessSigner 就能解锁完整功能；
 *   - 没有的用户，签名为空 → 适配器降级为「只读提醒」模式，
 *     仍然能看到作业和截止时间，只是不能自动提交。
 *
 * 这个降级设计比「要么全能要么不能用」友好得多。
 */

export interface SignRequest {
  /** 需要签名的字段，如 { uuid, courseId, fileId, ... } */
  payload: Record<string, string>;
  /** 平台自定义的算法标识，如 'ismart.ut' */
  algorithm: string;
}

export interface NativeSigner {
  readonly id: string;
  /** 是否可用（组件存在且版本匹配） */
  available(): Promise<boolean>;
  sign(req: SignRequest): Promise<string>;
}

/** 没有签名能力时的占位实现：显式失败，绝不返回假签名。 */
export class UnavailableSigner implements NativeSigner {
  readonly id = 'unavailable';

  async available(): Promise<boolean> {
    return false;
  }

  async sign(req: SignRequest): Promise<string> {
    throw new Error(`签名组件不可用，无法为 ${req.algorithm} 生成签名`);
  }
}
