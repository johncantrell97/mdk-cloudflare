export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none'

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
}

let currentLevel: number = LEVELS.info

/** Set the minimum log level. Defaults to 'info'. */
export function setLogLevel(level: LogLevel) {
  currentLevel = LEVELS[level]
}

export const log = {
  debug: (msg: string) => { if (currentLevel <= LEVELS.debug) console.log(msg) },
  info: (msg: string) => { if (currentLevel <= LEVELS.info) console.log(msg) },
  warn: (msg: string) => { if (currentLevel <= LEVELS.warn) console.warn(msg) },
  error: (msg: string) => { if (currentLevel <= LEVELS.error) console.error(msg) },
}
