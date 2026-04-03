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
        // Open lend positions on idle accounts
        const accounts = await ctx.twilight.walletAccounts()
        const idleAccounts = accounts.filter(a => a.ioType === 'Coin')

        for (const account of idleAccounts) {
          await ctx.twilight.openLend(account.index)

          // Track account in DB
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
        // Close lend positions — prefer DB-tracked accounts, fallback to wallet query
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

        ctx.log.info('Closed lend positions', { count: openPositions.length, apy })
        await ctx.alert.sendTradeAlert(this.id, 'close-lend', {
          positions: openPositions.length,
          apy,
        })
      } else if (hasOpenPositions && apy >= config.minApyThreshold) {
        // Rebalance check: if APY dropped significantly, consider closing to re-enter later
        const pool = await ctx.twilight.lendPool()
        const currentApy = pool.apy
        const apyDelta = Math.abs(currentApy - apy)
        if (apyDelta > config.rebalanceThreshold) {
          ctx.log.info('APY delta exceeds rebalance threshold', { apyDelta, threshold: config.rebalanceThreshold })
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
