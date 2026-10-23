/** 日志端口。适配器不能直接 console.log —— 桌面端要写文件，移动端要限流，CLI 要彩打。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export function createSilentLogger(): Logger {
  const noop = () => {};
  const silent: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silent,
  };
  return silent;
}
