import type { Strategy, StrategyInfo, RiskManager, Context } from '../types/index.js'
import { isProposable, applyAdjustedParams } from '../types/agent.js'

export interface SchedulerConfig {
  interval: number
}

interface SchedulerEntry {
  strategy: Strategy
  config: SchedulerConfig
  timer: ReturnType<typeof setInterval> | null
  ctx?: Context
}

export class Scheduler {
  private riskManager: RiskManager
  private entries: Map<string, SchedulerEntry> = new Map()

  constructor(riskManager: RiskManager) {
    this.riskManager = riskManager
  }

  async register(strategy: Strategy, config: SchedulerConfig, ctx?: Context): Promise<void> {
    this.entries.set(strategy.id, { strategy, config, timer: null, ctx })
  }

  async start(strategyId: string): Promise<void> {
    const entry = this.entries.get(strategyId)
    if (!entry) throw new Error(`Strategy not found: ${strategyId}`)
    if (entry.timer !== null) return

    const tick = async () => {
      try {
        const killActive = await this.riskManager.isKillSwitchActive()
        if (killActive) return

        if (isProposable(entry.strategy) && entry.ctx?.agent) {
          const agent = entry.ctx.agent
          const journal = entry.ctx.journal

          const proposal = await entry.strategy.propose(entry.ctx)
          if (!proposal) return

          if (!journal) {
            await entry.strategy.tick()
            return
          }

          // Prime regime cache so LLM gets current regime context
          await agent.detectRegime(proposal.marketSnapshot)

          const evaluation = await agent.evaluate(proposal, journal)
          journal.recordEvaluation({
            type: 'evaluation',
            timestamp: new Date().toISOString(),
            strategyId: entry.strategy.id,
            proposal,
            verdict: evaluation.verdict,
            confidence: evaluation.confidence,
            reasoning: evaluation.reasoning,
            regime: evaluation.regime ?? null,
            asi: { hypothesis: evaluation.reasoning },
          })

          // Timeout fallback: confidence === 0 means LLM failed, use static path
          if (evaluation.confidence === 0) {
            await entry.strategy.tick()
            return
          }

          if (evaluation.verdict === 'reject') return

          // Apply adjusted params to runtime config
          if (evaluation.verdict === 'adjust' && evaluation.adjustedParams) {
            const previousParams = applyAdjustedParams(entry.strategy, evaluation.adjustedParams)
            journal.recordAdjustment({
              type: 'adjustment',
              timestamp: new Date().toISOString(),
              strategyId: entry.strategy.id,
              previousParams,
              newParams: evaluation.adjustedParams,
              reasoning: evaluation.reasoning,
              confidence: evaluation.confidence,
              status: 'applied',
            })
          }

          // Execute (strategy re-fetches market data for current prices — proposal snapshot may be stale)
          await entry.strategy.execute(entry.ctx, evaluation)
        } else {
          await entry.strategy.tick()
        }
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
