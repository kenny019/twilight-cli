// Stub — WS-6 will implement
import type { RiskManager, RiskProfile } from '../types/index.js'
import type { Database } from '../types/index.js'

export class RiskManagerImpl implements RiskManager {
  constructor(_db: Database, _profile: RiskProfile) {
    throw new Error('Not implemented — WS-6')
  }
  checkPreTrade(_strategyId: string, _positionSizeSats: number, _totalBalanceSats: number): Promise<any> { throw new Error('Not implemented') }
  checkDrawdown(_strategyId: string): Promise<any> { throw new Error('Not implemented') }
  checkDailyLoss(): Promise<any> { throw new Error('Not implemented') }
  checkCooldown(_strategyId: string): Promise<any> { throw new Error('Not implemented') }
  isKillSwitchActive(): Promise<boolean> { throw new Error('Not implemented') }
  activateKillSwitch(): Promise<void> { throw new Error('Not implemented') }
  deactivateKillSwitch(): Promise<void> { throw new Error('Not implemented') }
  recordTrade(_strategyId: string, _pnl: number): Promise<void> { throw new Error('Not implemented') }
  checkConnectionHealth(_exchange: string): Promise<any> { throw new Error('Not implemented') }
  reportConnectionStatus(_exchange: string, _connected: boolean): void { throw new Error('Not implemented') }
}
