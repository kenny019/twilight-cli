import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { MarketDataPoint } from '../types/agent.js'

export function loadCSV(filePath: string): MarketDataPoint[] {
  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map((h) => h.trim())
  const tsIdx = headers.indexOf('timestamp')
  const priceIdx = headers.indexOf('price')
  const twIdx = headers.indexOf('twilightFundingRate')
  const bnIdx = headers.indexOf('binanceFundingRate')
  const volIdx = headers.indexOf('volume')
  const volatIdx = headers.indexOf('volatility')
  const lendIdx = headers.indexOf('lendingApy')

  if (tsIdx === -1 || priceIdx === -1) {
    throw new Error('CSV must have at least timestamp and price columns')
  }

  const points: MarketDataPoint[] = []

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim())
    const timestamp = cols[tsIdx]
    const price = parseFloat(cols[priceIdx])

    if (!timestamp || isNaN(price)) continue

    const point: MarketDataPoint = {
      timestamp,
      price,
      twilightFundingRate: twIdx !== -1 ? parseFloat(cols[twIdx]) || 0 : 0,
      binanceFundingRate: bnIdx !== -1 ? parseFloat(cols[bnIdx]) || 0 : 0,
    }

    if (volIdx !== -1 && cols[volIdx]) {
      const v = parseFloat(cols[volIdx])
      if (!isNaN(v)) point.volume = v
    }
    if (volatIdx !== -1 && cols[volatIdx]) {
      const v = parseFloat(cols[volatIdx])
      if (!isNaN(v)) point.volatility = v
    }
    if (lendIdx !== -1 && cols[lendIdx]) {
      const v = parseFloat(cols[lendIdx])
      if (!isNaN(v)) point.lendingApy = v
    }

    points.push(point)
  }

  return points
}

export function loadJSON(filePath: string): MarketDataPoint[] {
  const raw = readFileSync(filePath, 'utf-8')
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('JSON must be an array of MarketDataPoint objects')

  const points: MarketDataPoint[] = []

  for (const item of data) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>).timestamp !== 'string' ||
      typeof (item as Record<string, unknown>).price !== 'number'
    ) {
      continue
    }

    const obj = item as Record<string, unknown>
    const point: MarketDataPoint = {
      timestamp: obj.timestamp as string,
      price: obj.price as number,
      twilightFundingRate: typeof obj.twilightFundingRate === 'number' ? obj.twilightFundingRate : 0,
      binanceFundingRate: typeof obj.binanceFundingRate === 'number' ? obj.binanceFundingRate : 0,
    }

    if (typeof obj.volume === 'number') point.volume = obj.volume
    if (typeof obj.volatility === 'number') point.volatility = obj.volatility
    if (typeof obj.lendingApy === 'number') point.lendingApy = obj.lendingApy

    points.push(point)
  }

  return points
}

export function loadMarketData(filePath: string): MarketDataPoint[] {
  const ext = extname(filePath).toLowerCase()

  let points: MarketDataPoint[]
  if (ext === '.csv') {
    points = loadCSV(filePath)
  } else if (ext === '.json') {
    points = loadJSON(filePath)
  } else {
    throw new Error(`Unsupported file extension: ${ext} (expected .csv or .json)`)
  }

  if (points.length === 0) {
    throw new Error(`No valid market data points found in ${filePath}`)
  }

  points.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  return points
}
