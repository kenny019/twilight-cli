import type { Logger } from '../types/index.js'

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

function log(level: Level, prefix: string, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString()
  const tag = prefix ? ` [${prefix}]` : ''
  const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : ''
  console.log(`${ts} ${level}${tag} ${message}${metaStr}`)
}

export function createLogger(prefix = ''): Logger {
  return {
    info:  (message, meta) => log('INFO',  prefix, message, meta),
    warn:  (message, meta) => log('WARN',  prefix, message, meta),
    error: (message, meta) => log('ERROR', prefix, message, meta),
    debug: (message, meta) => log('DEBUG', prefix, message, meta),
  }
}
