import { writeFileSync } from 'node:fs'
import ccxt from 'ccxt'
import type { TwilightHistoricalFundingRate } from '../types/agent.js'

export interface FetchOptions {
  symbol: string
  from: string
  to: string
  twilightApiEndpoint: string
  output: string
}

export async function fetchBinanceHistory(
  symbol: string,
  from: string,
  to: string,
): Promise<Array<{ timestamp: string; price: number; binanceFundingRate: number; volume: number }>> {
  const exchange = new ccxt.binanceusdm()
  const fromMs = new Date(from).getTime()
  const toMs = new Date(to).getTime()

  try {
    // Fetch OHLCV with pagination (max 1000 candles per request)
    const allCandles: Array<{ timestamp: number; close: number; volume: number }> = []
    let since = fromMs

    while (since < toMs) {
      const ohlcv = await exchange.fetchOHLCV(symbol, '1h', since, 1000)
      if (ohlcv.length === 0) break

      for (const candle of ohlcv) {
        const ts = candle[0] as number
        if (ts > toMs) break
        allCandles.push({ timestamp: ts, close: candle[4] as number, volume: candle[5] as number })
      }

      const lastTs = ohlcv[ohlcv.length - 1][0] as number
      if (lastTs <= since) break // no progress
      since = lastTs + 1
    }

    // Fetch funding rate history with pagination
    const fundingRates = new Map<number, number>()
    let frSince: number | undefined = fromMs

    while (frSince !== undefined && frSince < toMs) {
      const rates = await exchange.fetchFundingRateHistory(symbol, frSince, 1000)
      if (rates.length === 0) break

      for (const rate of rates) {
        if (rate.timestamp && rate.timestamp <= toMs) {
          fundingRates.set(rate.timestamp, rate.fundingRate ?? 0)
        }
      }

      const lastTs = rates[rates.length - 1].timestamp
      if (lastTs === undefined || lastTs <= frSince) break
      frSince = lastTs + 1
    }

    // Merge: for each candle, find nearest funding rate
    return allCandles.map((candle) => {
      let nearestRate = 0
      let nearestDist = Infinity

      for (const [ts, rate] of fundingRates) {
        const dist = Math.abs(ts - candle.timestamp)
        if (dist < nearestDist) {
          nearestDist = dist
          nearestRate = rate
        }
      }

      return {
        timestamp: new Date(candle.timestamp).toISOString(),
        price: candle.close,
        binanceFundingRate: nearestRate,
        volume: candle.volume,
      }
    })
  } finally {
    await exchange.close()
  }
}

export async function fetchTwilightHistory(
  apiEndpoint: string,
  from: string,
  to: string,
): Promise<Array<{ timestamp: string; price: number; twilightFundingRate: number }>> {
  const url = apiEndpoint.replace(/\/$/, '') + '/api'
  const limit = 1000
  let offset = 0
  const results: Array<{ timestamp: string; price: number; twilightFundingRate: number }> = []

  while (true) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'historical_funding_rate',
      id: 1,
      params: { from, to, limit, offset },
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    if (!response.ok) {
      throw new Error(`Twilight API error: ${response.status} ${response.statusText}`)
    }

    const json = (await response.json()) as { result?: TwilightHistoricalFundingRate[]; error?: unknown }

    if (json.error) {
      throw new Error(`Twilight RPC error: ${JSON.stringify(json.error)}`)
    }

    const data = json.result ?? []

    for (const entry of data) {
      results.push({
        timestamp: entry.timestamp,
        price: parseFloat(entry.price),
        twilightFundingRate: parseFloat(entry.rate),
      })
    }

    if (data.length < limit) break
    offset += limit
  }

  return results
}

export async function fetchAndSave(opts: FetchOptions): Promise<number> {
  const [binanceData, twilightData] = await Promise.all([
    fetchBinanceHistory(opts.symbol, opts.from, opts.to),
    fetchTwilightHistory(opts.twilightApiEndpoint, opts.from, opts.to),
  ])

  // Merge by nearest timestamp
  const merged: Array<{
    timestamp: string
    price: number
    twilightFundingRate: number
    binanceFundingRate: number
    volume: number
  }> = []

  for (const bn of binanceData) {
    const bnTs = new Date(bn.timestamp).getTime()

    // Find nearest Twilight data point
    let nearestTw = { price: bn.price, twilightFundingRate: 0 }
    let nearestDist = Infinity

    for (const tw of twilightData) {
      const twTs = new Date(tw.timestamp).getTime()
      const dist = Math.abs(twTs - bnTs)
      if (dist < nearestDist) {
        nearestDist = dist
        nearestTw = tw
      }
    }

    merged.push({
      timestamp: bn.timestamp,
      price: nearestTw.price,
      twilightFundingRate: nearestTw.twilightFundingRate,
      binanceFundingRate: bn.binanceFundingRate,
      volume: bn.volume,
    })
  }

  // Sort by timestamp
  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  // Write CSV
  const header = 'timestamp,price,twilightFundingRate,binanceFundingRate,volume'
  const rows = merged.map(
    (r) => `${r.timestamp},${r.price},${r.twilightFundingRate},${r.binanceFundingRate},${r.volume}`,
  )
  writeFileSync(opts.output, [header, ...rows].join('\n') + '\n', 'utf-8')

  return merged.length
}
