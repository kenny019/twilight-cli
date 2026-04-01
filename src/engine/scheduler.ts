import type { Strategy, StrategyInfo, RiskManager } from '../types/index.js'

export interface SchedulerConfig {
  interval: number
}

interface SchedulerEntry {
  strategy: Strategy
  config: SchedulerConfig
  timer: ReturnType<typeof setInterval> | null
}

export class Scheduler {
  private riskManager: RiskManager
  private entries: Map<string, SchedulerEntry> = new Map()

  constructor(riskManager: RiskManager) {
    this.riskManager = riskManager
  }

  async register(strategy: Strategy, config: SchedulerConfig): Promise<void> {
    this.entries.set(strategy.id, { strategy, config, timer: null })
  }

  async start(strategyId: string): Promise<void> {
    const entry = this.entries.get(strategyId)
    if (!entry) throw new Error(`Strategy not found: ${strategyId}`)
    if (entry.timer !== null) return

    const tick = async () => {
      try {
        const killActive = await this.riskManager.isKillSwitchActive()
        if (killActive) return
        await entry.strategy.tick()
      } catch (err) {
        console.error(`[scheduler] Strategy ${strategyId} tick failed:`, (err as Error).message)
      }
    }

    entry.timer = setInterval(() => { void tick() }, entry.config.interval)
  }

  async stop(strategyId: string): Promise<void> {
    const entry = this.entries.get(strategyId)
    if (!entry) return
    if (entry.timer !== null) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    await entry.strategy.stop()
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.entries.keys())
    await Promise.all(ids.map(id => this.stop(id)))
  }

  getStatuses(): StrategyInfo[] {
    return Array.from(this.entries.values()).map(e => e.strategy.status())
  }
}
