import type { RiskManager, RiskProfile, RiskCheckResult, RiskProfileConfig, Database } from '../types/index.js'
import { RISK_PROFILES, DAILY_LOSS_LIMIT_PCT } from '../types/index.js'

interface TradeEntry {
  strategyId: string
  pnl: number
  timestamp: number
}

function todayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export class RiskManagerImpl implements RiskManager {
  private db: Database
  private profile: RiskProfileConfig
  private trades: TradeEntry[] = []
  private connectionStatus: Map<string, { connected: boolean; disconnectedAt: number | null }> = new Map()

  constructor(db: Database, profile: RiskProfile) {
    this.db = db
    this.profile = RISK_PROFILES[profile]
  }

  async checkPreTrade(
    strategyId: string,
    positionSizeSats: number,
    totalBalanceSats: number,
  ): Promise<RiskCheckResult> {
    if (await this.isKillSwitchActive()) {
      return { allowed: false, control: 'killSwitch' }
    }

    const cap = (this.profile.positionSizeCapPct / 100) * totalBalanceSats
    if (positionSizeSats > cap) {
      return { allowed: false, control: 'positionSizeCap' }
    }

    return { allowed: true }
  }

  async checkDrawdown(strategyId: string): Promise<RiskCheckResult> {
    const strategy = this.db.getStrategy(strategyId)
    if (!strategy) {
      return { allowed: true }
    }

    let config: { initialBalance?: number } = {}
    try {
      config = JSON.parse(strategy.config)
    } catch {
      // malformed config — skip check
    }

    const initialBalance = config.initialBalance
    if (!initialBalance) {
      return { allowed: true }
    }

    const cumulativePnl = this.trades
      .filter((t) => t.strategyId === strategyId)
      .reduce((sum, t) => sum + t.pnl, 0)

    // Only trigger on net loss
    if (cumulativePnl >= 0) {
      return { allowed: true }
    }

    const drawdownPct = (Math.abs(cumulativePnl) / initialBalance) * 100
    if (drawdownPct > this.profile.maxDrawdownPct) {
      return { allowed: false, control: 'maxDrawdown' }
    }

    return { allowed: true }
  }

  async checkDailyLoss(): Promise<RiskCheckResult> {
    const start = todayStart()
    const todayTrades = this.trades.filter((t) => t.timestamp >= start)

    if (todayTrades.length === 0) {
      return { allowed: true }
    }

    const totalDailyPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0)
    if (totalDailyPnl >= 0) {
      return { allowed: true }
    }

    // Sum initialBalances across all strategies to get total portfolio balance
    const allStrategies = this.db.listStrategies()
    let totalBalance = 0
    for (const s of allStrategies) {
      try {
        const cfg = JSON.parse(s.config)
        if (typeof cfg.initialBalance === 'number') {
          totalBalance += cfg.initialBalance
        }
      } catch {
        // skip unparseable configs
      }
    }

    if (totalBalance === 0) {
      return { allowed: true }
    }

    const dailyLossPct = (Math.abs(totalDailyPnl) / totalBalance) * 100
    if (dailyLossPct > DAILY_LOSS_LIMIT_PCT) {
      return { allowed: false, control: 'dailyLossLimit' }
    }

    return { allowed: true }
  }

  async checkCooldown(strategyId: string): Promise<RiskCheckResult> {
    if (this.profile.cooldownMinutes === 0) {
      return { allowed: true }
    }

    const strategyTrades = this.trades.filter((t) => t.strategyId === strategyId)
    if (strategyTrades.length === 0) {
      return { allowed: true }
    }

    const latest = strategyTrades[strategyTrades.length - 1]
    if (latest.pnl >= 0) {
      return { allowed: true }
    }

    const cooldownMs = this.profile.cooldownMinutes * 60 * 1000
    const elapsed = Date.now() - latest.timestamp
    if (elapsed < cooldownMs) {
      return { allowed: false, control: 'cooldown' }
    }

    return { allowed: true }
  }

  async checkConnectionHealth(exchange: string): Promise<RiskCheckResult> {
    const status = this.connectionStatus.get(exchange)
    if (!status) {
      // Never reported — assume healthy
      return { allowed: true }
    }

    if (!status.connected) {
      return { allowed: false, control: 'connectionWatchdog' }
    }

    return { allowed: true }
  }

  reportConnectionStatus(exchange: string, connected: boolean): void {
    this.connectionStatus.set(exchange, {
      connected,
      disconnectedAt: connected ? null : Date.now(),
    })
  }

  async isKillSwitchActive(): Promise<boolean> {
    return this.db.getKV('kill_switch') === 'true'
  }

  async activateKillSwitch(): Promise<void> {
    this.db.setKV('kill_switch', 'true')
  }

  async deactivateKillSwitch(): Promise<void> {
    this.db.setKV('kill_switch', 'false')
  }

  async recordTrade(strategyId: string, pnl: number): Promise<void> {
    this.trades.push({ strategyId, pnl, timestamp: Date.now() })
  }
}
