import type { Strategy, StrategyConfig, StrategyInfo, Context } from '../../types/index.js'

interface FundingArbConfig {
  entryThreshold: number
  exitThreshold: number
  positionSizeSats: number
  checkIntervalMs: number
}

export class FundingArbStrategy implements Strategy {
  id = 'funding-arb'
  name = 'Funding Rate Arbitrage'
  description = 'Delta-neutral funding rate arbitrage between Twilight and Binance'

  configSchema = {
    type: 'object',
    properties: {
      entryThreshold:    { type: 'number', description: 'Minimum rate differential to open positions' },
      exitThreshold:     { type: 'number', description: 'Rate differential below which positions are closed' },
      positionSizeSats:  { type: 'number', description: 'Position size in satoshis' },
      checkIntervalMs:   { type: 'number', description: 'Polling interval in milliseconds' },
    },
    required: ['entryThreshold', 'exitThreshold', 'positionSizeSats', 'checkIntervalMs'],
  }

  private config!: FundingArbConfig
  private ctx!: Context
  private tickCount = 0
  private errorCount = 0
  private lastTick: string | null = null
  private running = true

  async init(config: StrategyConfig, ctx: Context): Promise<void> {
    this.config = config as unknown as FundingArbConfig
    this.ctx = ctx
  }

  async tick(): Promise<void> {
    const { ctx, config } = this

    try {
      const [twilightRate, binanceRate, price] = await Promise.all([
        ctx.twilight.fundingRate(),
        ctx.binance.getFundingRate(),
        ctx.twilight.marketPrice(),
      ])

      const differential = Math.abs(binanceRate - twilightRate)
      const openPositions = ctx.db.listPositions({ strategyId: this.id, status: 'open' })
      const hasOpenPositions = openPositions.length > 0

      if (!hasOpenPositions && differential > config.entryThreshold) {
        // Rate floor warning: fees and funding rates use different time horizons,
        // so we warn rather than block (entryThreshold is the user's profitability gate)
        const fees = await ctx.twilight.feeRate()
        const roundTripFee = fees.marketFill + fees.marketSettle
        if (differential < roundTripFee) {
          ctx.log.warn('Differential below round-trip fees — trade may not be profitable', { differential, roundTripFee })
        }

        const { sats: totalBalance } = await ctx.twilight.walletBalance()
        const riskCheck = await ctx.risk.checkPreTrade(this.id, config.positionSizeSats, totalBalance)
        if (!riskCheck.allowed) {
          ctx.log.warn('Risk check blocked entry', { control: riskCheck.control })
          await ctx.alert.sendRiskAlert(this.id, riskCheck)
          return
        }

        // Find idle Twilight account
        const accounts = await ctx.twilight.walletAccounts()
        const idleAccount = accounts.find(a => a.ioType === 'Coin')
        if (!idleAccount) {
          ctx.log.warn('No idle Twilight account available')
          return
        }

        const btcSize = config.positionSizeSats / 1e8

        const [twilightResult] = await Promise.all([
          ctx.twilight.openTrade(idleAccount.index, 'LONG', price, 1),
          ctx.binance.openPosition('SHORT', btcSize, 1),
        ])

        // Track account usage in DB
        ctx.db.createAccount({
          exchange: 'twilight',
          accountIndex: idleAccount.index,
          status: 'active',
          balance: config.positionSizeSats,
        })

        const position = ctx.db.createPosition({
          strategyId: this.id,
          exchange: 'twilight',
          side: 'LONG',
          entryPrice: price,
          size: config.positionSizeSats,
          leverage: 1,
          status: 'open',
        })

        ctx.db.createTrade({
          positionId: position.id,
          type: 'open',
          price,
          size: config.positionSizeSats,
          fee: 0,
          pnl: 0,
        })

        await ctx.alert.sendTradeAlert(this.id, 'open', {
          twilightRequestId: twilightResult.requestId,
          accountIndex: idleAccount.index,
          differential,
          price,
        })
      } else if (hasOpenPositions && differential < config.exitThreshold) {
        const binancePosition = await ctx.binance.getPosition()
        const size = binancePosition?.size ?? 0

        // Close Twilight positions — prefer DB-tracked accounts, fallback to wallet query
        const trackedAccounts = ctx.db.listAccounts({ exchange: 'twilight', status: 'active' })
        const closeOps: Promise<unknown>[] = []

        if (trackedAccounts.length > 0) {
          for (const acc of trackedAccounts) {
            closeOps.push(ctx.twilight.closeTrade(acc.accountIndex))
          }
        } else {
          const walletAccounts = await ctx.twilight.walletAccounts()
          for (let i = 0; i < openPositions.length && i < walletAccounts.length; i++) {
            closeOps.push(ctx.twilight.closeTrade(walletAccounts[i].index))
          }
        }
        closeOps.push(ctx.binance.closePosition('SHORT', size))
        await Promise.all(closeOps)

        for (const acc of trackedAccounts) {
          ctx.db.updateAccount(acc.id, { status: 'idle' })
        }

        for (const pos of openPositions) {
          ctx.db.updatePosition(pos.id, { status: 'closed', closedAt: new Date().toISOString() })
        }

        ctx.log.info('Closed delta-neutral position', { differential })
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
