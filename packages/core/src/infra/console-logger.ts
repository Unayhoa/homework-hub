/** 控制台日志实现。CLI 与开发调试用。 */
import type { LogFields, LogLevel, Logger } from '../ports/logger.ts';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  color?: boolean;
  /** 额外字段过滤：比如永远不打印 cookie 字段 */
  redactKeys?: string[];
}

const DEFAULT_REDACT = ['cookie', 'password', 'pwd', 'token', 'authorization', 'secret', 'ut'];

function redact(fields: LogFields, keys: string[]): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (keys.some((r) => k.toLowerCase().includes(r))) {
      out[k] = typeof v === 'string' ? `<已脱敏 len=${v.length}>` : '<已脱敏>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #color: boolean;
  readonly #bindings: LogFields;
  readonly #redactKeys: string[];

  constructor(opts: ConsoleLoggerOptions = {}, bindings: LogFields = {}) {
    this.#level = opts.level ?? 'info';
    this.#color = opts.color ?? true;
    this.#bindings = bindings;
    this.#redactKeys = opts.redactKeys ?? DEFAULT_REDACT;
  }

  child(bindings: LogFields): Logger {
    return new ConsoleLogger(
      { level: this.#level, color: this.#color, redactKeys: this.#redactKeys },
      { ...this.#bindings, ...bindings },
    );
  }

  #emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;

    const time = new Date().toISOString().slice(11, 23);
    const tag = level.toUpperCase().padEnd(5);
    const head = this.#color ? `${DIM}${time}${RESET} ${COLOR[level]}${tag}${RESET}` : `${time} ${tag}`;

    const scope = Object.entries(this.#bindings)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');

    const extra = Object.entries(redact(fields ?? {}, this.#redactKeys))
      .filter(([k]) => !(k in this.#bindings))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');

    const line = [head, scope ? `${DIM}[${scope}]${RESET}` : '', msg, extra ? `${DIM}${extra}${RESET}` : '']
      .filter(Boolean)
      .join(' ');

    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  }

  debug(msg: string, fields?: LogFields): void {
    this.#emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.#emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.#emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.#emit('error', msg, fields);
  }
}
