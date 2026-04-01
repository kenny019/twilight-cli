// Stub — WS-7 will implement
import type { Strategy } from '../types/index.js'

export class StrategyLoader {
  constructor(_directories: string[]) {}
  async loadAll(): Promise<Strategy[]> {
    throw new Error('Not implemented — WS-7')
  }
}
