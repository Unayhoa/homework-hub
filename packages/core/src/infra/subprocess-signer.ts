/**
 * Native 签名桥的进程外实现。
 *
 * 背景（这是本项目最硬的一块技术难点）：
 * iSmart 把答案提交请求的 `ut` 字段签名逻辑编译进了原生 so/dll，
 * 社区验证只能靠 unidbg 之类的框架在模拟环境里直接执行那个 so。
 * 纯 JS/TS 拿不到签名，而签名不对后端就不认。
 *
 * 架构选择：不在主进程里做这件事，而是把签名能力外包给一个独立的可执行文件。
 * 理由有三：
 *   1. 崩溃隔离。unidbg 跑在 JVM 里，内存占用大且容易出问题，
 *      不能让它拖垮整个同步进程。
 *   2. 许可清晰。签名组件往往是 GPL 或来源不明的二进制，
 *      通过 stdin/stdout 的进程边界调用，可以避免许可传染（不做静态链接）。
 *   3. 可替换。用户可以换成自己的实现，只要遵守同一份协议。
 *
 * IPC 协议（极简，故意选 JSON over stdio 而不是 gRPC）：
 *   请求（一行 JSON 写到子进程 stdin）:
 *     {"algorithm":"ismart.ut","payload":{"uuid":"...","courseId":"..."}}
 *   响应（一行 JSON 从 stdout 读）:
 *     成功 {"ok":true,"signature":"..."}
 *     失败 {"ok":false,"error":"..."}
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { NativeSigner, SignRequest } from '../ports/signer.ts';

export interface SubprocessSignerOptions {
  /** 可执行文件路径 */
  command: string;
  /** 附加参数 */
  args?: string[];
  /** 单次签名超时（unidbg 冷启动可能需要几秒，不要设太小） */
  timeoutMs?: number;
  /** 同时最多几个签名进程（每个进程内存开销大） */
  maxConcurrency?: number;
}

export class SubprocessSigner implements NativeSigner {
  readonly id = 'subprocess';
  readonly #opts: Required<SubprocessSignerOptions>;
  #active = 0;
  #probed: boolean | undefined;

  constructor(opts: SubprocessSignerOptions) {
    this.#opts = {
      args: opts.args ?? [],
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxConcurrency: opts.maxConcurrency ?? 1,
      command: opts.command,
    };
  }

  async available(): Promise<boolean> {
    if (this.#probed !== undefined) return this.#probed;
    try {
      await access(this.#opts.command, constants.X_OK);
      this.#probed = true;
    } catch {
      this.#probed = false;
    }
    return this.#probed;
  }

  async sign(req: SignRequest): Promise<string> {
    if (this.#active >= this.#opts.maxConcurrency) {
      throw new Error(`签名进程已达并发上限 ${this.#opts.maxConcurrency}，请稍后重试`);
    }
    this.#active += 1;
    try {
      const line = JSON.stringify({ algorithm: req.algorithm, payload: req.payload });
      const stdout = await this.#run(line);
      const parsed = JSON.parse(stdout.trim()) as
        | { ok: true; signature: string }
        | { ok: false; error?: string };
      if (!parsed.ok) throw new Error(parsed.error ?? '签名组件返回失败但未给出原因');
      return parsed.signature;
    } finally {
      this.#active -= 1;
    }
  }

  #run(input: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.#opts.command, this.#opts.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`签名组件超时（${this.#opts.timeoutMs}ms）`));
      }, this.#opts.timeoutMs);

      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      child.on('error', (e) => done(() => reject(new Error(`无法启动签名组件：${e.message}`))));
      child.on('close', (code) =>
        done(() =>
          code === 0
            ? resolve(out)
            : reject(new Error(`签名组件退出码 ${code}：${err.trim() || out.trim() || '无输出'}`)),
        ),
      );

      child.stdin?.write(input);
      child.stdin?.end();
    });
  }
}
