import { fn, f } from '@ax-llm/ax'
import type { AxFunction } from '@ax-llm/ax'
import type { Context } from '../../types/index.js'

export function createMarketTools(ctx: Context): AxFunction[] {
  const getFundingDifferential = fn('getFundingDifferential')
    .description('Get the funding rate differential between Twilight and Binance exchanges')
    .returns(
      f.object({
        twilightRate: f.number('Twilight funding rate'),
        binanceRate: f.number('Binance funding rate'),
        differential: f.number('Twilight minus Binance rate'),
      }, 'Funding rate differential')
    )
    .handler(async () => {
      const [twilightRate, binanceRate] = await Promise.all([
        ctx.twilight.fundingRate(),
        ctx.binance.getFundingRate(),
      ])
      return {
        twilightRate,
        binanceRate,
        differential: twilightRate - binanceRate,
      }
    })
    .build()

  const getPrice = fn('getPrice')
    .description('Get current BTC price from both Twilight and Binance exchanges')
    .returns(
      f.object({
        twilightPrice: f.number('Twilight BTC price'),
        binancePrice: f.number('Binance BTC price'),
      }, 'Exchange prices')
    )
    .handler(async () => {
      const [twilightPrice, binancePrice] = await Promise.all([
        ctx.twilight.marketPrice(),
        ctx.binance.getPrice(),
      ])
      return { twilightPrice, binancePrice }
    })
    .build()

  const getOrderbook = fn('getOrderbook')
    .description('Get top 5 bids and asks from the Twilight orderbook')
    .returns(
      f.object({
        bids: f.json('Top 5 bids as [price, size] arrays'),
        asks: f.json('Top 5 asks as [price, size] arrays'),
      }, 'Orderbook snapshot')
    )
    .handler(async () => {
      const book = await ctx.twilight.orderbook()
      return {
        bids: book.bids.slice(0, 5),
        asks: book.asks.slice(0, 5),
      }
    })
    .build()

  const getLendPool = fn('getLendPool')
    .description('Get Twilight lending pool statistics and APY')
    .returns(
      f.object({
        totalDeposits: f.number('Total deposits in the pool (sats)'),
        shareValue: f.number('Current share value'),
        apy: f.number('Annual percentage yield'),
      }, 'Lending pool stats')
    )
    .handler(async () => {
      const pool = await ctx.twilight.lendPool()
      return {
        totalDeposits: pool.totalDeposits,
        shareValue: pool.shareValue,
        apy: pool.apy,
      }
    })
    .build()

  return [getFundingDifferential, getPrice, getOrderbook, getLendPool]
}
