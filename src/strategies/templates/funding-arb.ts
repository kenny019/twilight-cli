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
      const [twilightRate, binanceRate] = await Promise.all([
        ctx.twilight.fundingRate(),
        ctx.binance.getFundingRate(),
      ])

      const differential = Math.abs(binanceRate - twilightRate)
      const openPositions = ctx.db.listPositions({ strategyId: this.id, status: 'open' })
      const hasOpenPositions = openPositions.length > 0

      if (!hasOpenPositions && differential > config.entryThreshold) {
        const riskCheck = await ctx.risk.checkPreTrade(this.id, config.positionSizeSats, 0)
        if (!riskCheck.allowed) {
          ctx.log.warn('Risk check blocked entry', { reason: riskCheck.reason })
          return
        }

        const price = await ctx.twilight.marketPrice()

        // Determine position size in BTC for Binance (positionSizeSats / 1e8 * price, simplified to 1 unit)
        const btcSize = config.positionSizeSats / 1e8

        const [twilightResult] = await Promise.all([
          ctx.twilight.openTrade(0, 'LONG', price, 1),
          ctx.binance.openPosition('SHORT', btcSize, 1),
        ])

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
          differential,
          price,
        })
      } else if (hasOpenPositions && differential < config.exitThreshold) {
        const binancePosition = await ctx.binance.getPosition()
        const size = binancePosition?.size ?? 0

        await Promise.all([
          ctx.twilight.closeTrade(0),
          ctx.binance.closePosition('SHORT', size),
        ])

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
