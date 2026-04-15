import { fn, f } from '@ax-llm/ax'
import type { AxFunction } from '@ax-llm/ax'
import type { Context } from '../../types/index.js'

export function createPortfolioTools(ctx: Context): AxFunction[] {
  const getPositions = fn('getPositions')
    .description('Get all open positions from the database')
    .returns(f.json('Array of open position records'))
    .handler(async () => {
      return ctx.db.listPositions({ status: 'open' })
    })
    .build()

  const getPnL = fn('getPnL')
    .description('Get total and per-strategy PnL from trade records')
    .returns(
      f.object({
        totalPnl: f.number('Total PnL across all strategies'),
        byStrategy: f.json('PnL breakdown keyed by strategy ID'),
      }, 'PnL summary')
    )
    .handler(async () => {
      const trades = ctx.db.listTrades({})
      let totalPnl = 0
      const byStrategy: Record<string, number> = {}

      for (const trade of trades) {
        totalPnl += trade.pnl
        // Resolve strategy via position
        const position = ctx.db.getPosition(trade.positionId)
        if (position) {
          byStrategy[position.strategyId] = (byStrategy[position.strategyId] ?? 0) + trade.pnl
        }
      }

      return { totalPnl, byStrategy }
    })
    .build()

  const getAccountBalances = fn('getAccountBalances')
    .description('Get Twilight wallet balance and Binance margin balance')
    .returns(
      f.object({
        twilightSats: f.number('Twilight wallet balance in sats'),
        binanceMargin: f.number('Binance margin balance in USD'),
      }, 'Account balances')
    )
    .handler(async () => {
      const [wallet, margin] = await Promise.all([
        ctx.twilight.walletBalance(),
        ctx.binance.getMarginBalance(),
      ])
      return {
        twilightSats: wallet.sats,
        binanceMargin: margin,
      }
    })
    .build()

  return [getPositions, getPnL, getAccountBalances]
}
