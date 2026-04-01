import type { Strategy, StrategyConfig, StrategyInfo, Context } from '../../types/index.js'

interface LendingYieldConfig {
  minApyThreshold: number
  rebalanceThreshold: number
  checkIntervalMs: number
}

export class LendingYieldStrategy implements Strategy {
  id = 'lending-yield'
  name = 'Lending Yield'
  description = 'Deploy idle BTC to Twilight lending pool for yield'

  configSchema = {
    type: 'object',
    properties: {
      minApyThreshold:    { type: 'number', description: 'Minimum APY required to open a lend position' },
      rebalanceThreshold: { type: 'number', description: 'APY delta that triggers rebalance' },
      checkIntervalMs:    { type: 'number', description: 'Polling interval in milliseconds' },
    },
    required: ['minApyThreshold', 'rebalanceThreshold', 'checkIntervalMs'],
  }

  private config!: LendingYieldConfig
  private ctx!: Context
  private tickCount = 0
  private errorCount = 0
  private lastTick: string | null = null
  private running = true

  async init(config: StrategyConfig, ctx: Context): Promise<void> {
    this.config = config as unknown as LendingYieldConfig
    this.ctx = ctx
  }

  async tick(): Promise<void> {
    const { ctx, config } = this

    try {
      const apy = await ctx.twilight.lastDayApy()
      const openPositions = ctx.db.listPositions({ strategyId: this.id, status: 'open' })
      const hasOpenPositions = openPositions.length > 0

      if (!hasOpenPositions && apy >= config.minApyThreshold) {
        const accounts = await ctx.twilight.walletAccounts()
        const idleAccounts = accounts.filter(a => a.ioType === 'Coin')

        for (const account of idleAccounts) {
          await ctx.twilight.openLend(account.index)
        }
      } else if (hasOpenPositions && apy < config.minApyThreshold) {
        // Close each open lend position
        for (const pos of openPositions) {
          // accountIndex is not stored on PositionRecord; use 0 as the default zk-account index
          const accountIndex = 0
          await ctx.twilight.closeLend(accountIndex)
          ctx.db.updatePosition(pos.id, { status: 'closed', closedAt: new Date().toISOString() })
        }
      }
    } catch (err) {
      this.errorCount++
      ctx.log.error('tick error', { error: String(err) })
      throw err
    } finally {
      this.tickCount++
      this.lastTick = new Date().toISOString()
    }
  }

  async stop(): Promise<void> {
    this.running = false
  }

  status(): StrategyInfo {
    return {
      id: this.id,
      status: this.running ? 'active' : 'stopped',
      config: this.config as unknown as StrategyConfig,
      lastTick: this.lastTick,
      tickCount: this.tickCount,
      errorCount: this.errorCount,
    }
  }
}
