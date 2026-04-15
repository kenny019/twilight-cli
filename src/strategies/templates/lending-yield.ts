import type { Strategy, StrategyConfig, StrategyInfo, Context } from '../../types/index.js'
import type { ProposableStrategy, TradeProposal, AgentEvaluation } from '../../types/agent.js'
import { DEFAULT_EVALUATION } from '../../types/agent.js'

interface LendingYieldConfig {
  minApyThreshold: number
  rebalanceThreshold: number
  checkIntervalMs: number
}

export class LendingYieldStrategy implements Strategy, ProposableStrategy {
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

  config!: LendingYieldConfig
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
    const proposal = await this.propose(this.ctx)
    if (!proposal) {
      this.tickCount++
      this.lastTick = new Date().toISOString()
      return
    }
    await this.execute(this.ctx, DEFAULT_EVALUATION)
  }

  async propose(ctx: Context): Promise<TradeProposal | null> {
    try {
      const apy = await ctx.twilight.lastDayApy()
      const openPositions = ctx.db.listPositions({ strategyId: this.id, status: 'open' })
      const hasOpenPositions = openPositions.length > 0
      const price = await ctx.twilight.marketPrice()

      const snapshot = {
        price,
        twilightFundingRate: 0,
        binanceFundingRate: 0,
        differential: 0,
        lendingApy: apy,
        timestamp: new Date().toISOString(),
      }

      if (!hasOpenPositions && apy >= this.config.minApyThreshold) {
        return {
          strategyId: this.id,
          action: 'open',
          reason: `Lending APY ${apy.toFixed(2)}% exceeds minimum ${this.config.minApyThreshold}%`,
          marketSnapshot: snapshot,
        }
      }

      if (hasOpenPositions && apy < this.config.minApyThreshold) {
        return {
          strategyId: this.id,
          action: 'close',
          reason: `Lending APY ${apy.toFixed(2)}% below minimum ${this.config.minApyThreshold}%`,
          marketSnapshot: snapshot,
        }
      }

      // Rebalance check
      if (hasOpenPositions && apy >= this.config.minApyThreshold) {
        const pool = await ctx.twilight.lendPool()
        const apyDelta = Math.abs(pool.apy - apy)
        if (apyDelta > this.config.rebalanceThreshold) {
          return {
            strategyId: this.id,
            action: 'rebalance',
            reason: `APY delta ${apyDelta.toFixed(2)} exceeds rebalance threshold ${this.config.rebalanceThreshold}`,
            marketSnapshot: { ...snapshot, lendingApy: pool.apy },
          }
        }
      }

      return null
    } catch (err) {
      this.errorCount++
      ctx.log.error('propose error', { error: String(err) })
      throw err
    }
  }

  async execute(ctx: Context, evaluation: AgentEvaluation): Promise<void> {
    const { config } = this

    try {
      const apy = await ctx.twilight.lastDayApy()
      const openPositions = ctx.db.listPositions({ strategyId: this.id, status: 'open' })
      const hasOpenPositions = openPositions.length > 0

      if (!hasOpenPositions && apy >= config.minApyThreshold) {
        const accounts = await ctx.twilight.walletAccounts()
        const idleAccounts = accounts.filter(a => a.ioType === 'Coin')

        for (const account of idleAccounts) {
          await ctx.twilight.openLend(account.index)

          ctx.db.createAccount({
            exchange: 'twilight',
            accountIndex: account.index,
            status: 'active',
            balance: account.balance,
          })

          ctx.db.createPosition({
            strategyId: this.id,
            exchange: 'twilight',
            side: 'LONG',
            entryPrice: 0,
            size: account.balance,
            leverage: 1,
            status: 'open',
          })
        }

        if (idleAccounts.length > 0) {
          ctx.log.info('Opened lend positions', { count: idleAccounts.length, apy })
          await ctx.alert.sendTradeAlert(this.id, 'open-lend', {
            accounts: idleAccounts.length,
            apy,
          })
        }
      } else if (hasOpenPositions && apy < config.minApyThreshold) {
        const trackedAccounts = ctx.db.listAccounts({ exchange: 'twilight', status: 'active' })

        if (trackedAccounts.length > 0) {
          for (const acc of trackedAccounts) {
            await ctx.twilight.closeLend(acc.accountIndex)
            ctx.db.updateAccount(acc.id, { status: 'idle' })
          }
        } else {
          const walletAccounts = await ctx.twilight.walletAccounts()
          for (let i = 0; i < openPositions.length && i < walletAccounts.length; i++) {
            await ctx.twilight.closeLend(walletAccounts[i].index)
          }
        }

        for (const pos of openPositions) {
          ctx.db.updatePosition(pos.id, { status: 'closed', closedAt: new Date().toISOString() })
        }

        // Record outcome in journal
        ctx.journal?.recordOutcome({
          type: 'outcome',
          timestamp: new Date().toISOString(),
          strategyId: this.id,
          evaluationTimestamp: new Date().toISOString(),
          pnl: 0,
          holdDurationMs: 0,
          exitReason: `APY ${apy.toFixed(2)}% below minimum threshold`,
          metrics: { apy },
        })

        ctx.log.info('Closed lend positions', { count: openPositions.length, apy })
        await ctx.alert.sendTradeAlert(this.id, 'close-lend', {
          positions: openPositions.length,
          apy,
        })
      } else if (hasOpenPositions && apy >= config.minApyThreshold) {
        const pool = await ctx.twilight.lendPool()
        const currentApy = pool.apy
        const apyDelta = Math.abs(currentApy - apy)
        if (apyDelta > config.rebalanceThreshold) {
          ctx.log.info('APY delta exceeds rebalance threshold', { apyDelta, threshold: config.rebalanceThreshold })
        }
      }
    } catch (err) {
      this.errorCount++
      ctx.log.error('execute error', { error: String(err) })
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
