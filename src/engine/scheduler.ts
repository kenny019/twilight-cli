// Stub — WS-7 will implement
import type { Strategy, StrategyInfo, RiskManager } from '../types/index.js'

export interface SchedulerConfig {
  interval: number
}

export class Scheduler {
  constructor(_riskManager: RiskManager) {
    throw new Error('Not implemented — WS-7')
  }
  async register(_strategy: Strategy, _config: SchedulerConfig): Promise<void> { throw new Error('Not implemented') }
  async start(_strategyId: string): Promise<void> { throw new Error('Not implemented') }
  async stop(_strategyId: string): Promise<void> { throw new Error('Not implemented') }
  async shutdown(): Promise<void> { throw new Error('Not implemented') }
  getStatuses(): StrategyInfo[] { throw new Error('Not implemented') }
}
