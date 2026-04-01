import * as ccxt from 'ccxt'
import type {
  BinanceClient,
  BinanceOrderResult,
  BinancePosition,
  OrderSide,
  OrderType,
} from '../types/index.js'

export interface BinanceClientConfig {
  apiKey: string
  apiSecret: string
  symbol?: string
  testnet?: boolean
}

const DEFAULT_SYMBOL = 'BTC/USDT:USDT'
const WATCH_INTERVAL_MS = 5000

export class BinanceClientImpl implements BinanceClient {
  // Non-enumerable so JSON.stringify never surfaces credentials
  readonly #exchange: any
  readonly #symbol: string

  constructor(config: BinanceClientConfig) {
    this.#symbol = config.symbol ?? DEFAULT_SYMBOL

    const exchangeConfig = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      options: { defaultType: 'future' },
    }

    // Use REST client (ccxt.binanceusdm); pro variant available if needed
    this.#exchange = new (ccxt as any).binanceusdm(exchangeConfig)

    if (config.testnet) {
      this.#exchange.options = {
        ...this.#exchange.options,
        sandboxMode: true,
      }
    }
  }

  // ─── Market data ────────────────────────────────────────────────

  async getPrice(symbol?: string): Promise<number> {
    const ticker = await this.#exchange.fetchTicker(symbol ?? this.#symbol)
    return ticker.last as number
  }

  async getFundingRate(symbol?: string): Promise<number> {
    const result = await this.#exchange.fetchFundingRate(symbol ?? this.#symbol)
    return result.fundingRate as number
  }

  async getOrderbook(symbol?: string): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }> {
    const book = await this.#exchange.fetchOrderBook(symbol ?? this.#symbol)
    return {
      bids: book.bids as Array<[number, number]>,
      asks: book.asks as Array<[number, number]>,
    }
  }

  // ─── Trading ────────────────────────────────────────────────────

  async openPosition(
    side: OrderSide,
    size: number,
    leverage: number,
    orderType: OrderType = 'MARKET',
  ): Promise<BinanceOrderResult> {
    const sym = this.#symbol
    await this.#exchange.setLeverage(leverage, sym)

    const ccxtSide = side === 'LONG' ? 'buy' : 'sell'
    const ccxtType = orderType === 'LIMIT' ? 'limit' : 'market'

    const order = await this.#exchange.createOrder(sym, ccxtType, ccxtSide, size)
    return mapOrder(order)
  }

  async closePosition(side: OrderSide, size: number): Promise<BinanceOrderResult> {
    // Close by going in the opposite direction
    const ccxtSide = side === 'LONG' ? 'sell' : 'buy'
    const order = await this.#exchange.createOrder(this.#symbol, 'market', ccxtSide, size)
    return mapOrder(order)
  }

  async getPosition(symbol?: string): Promise<BinancePosition | null> {
    const sym = symbol ?? this.#symbol
    const positions = await this.#exchange.fetchPositions([sym])
    const pos = (positions as any[]).find((p: any) => p.symbol === sym)
    return pos ? mapPosition(pos) : null
  }

  async getPositions(): Promise<BinancePosition[]> {
    const positions = await this.#exchange.fetchPositions()
    return (positions as any[]).map(mapPosition)
  }

  // ─── Account ────────────────────────────────────────────────────

  async getBalance(): Promise<number> {
    const balance = await this.#exchange.fetchBalance()
    return (balance.total as Record<string, number>).BTC
  }

  async getMarginBalance(): Promise<number> {
    const balance = await this.#exchange.fetchBalance()
    return Number((balance as any).info.totalMarginBalance)
  }

  // ─── WebSocket with REST fallback ────────────────────────────────

  async watchPrice(callback: (price: number) => void): Promise<() => void> {
    const id = setInterval(async () => {
      try {
        const price = await this.getPrice()
        callback(price)
      } catch {
        // swallow transient errors in polling loop
      }
    }, WATCH_INTERVAL_MS)

    return () => clearInterval(id)
  }

  async watchFundingRate(callback: (rate: number) => void): Promise<() => void> {
    const id = setInterval(async () => {
      try {
        const rate = await this.getFundingRate()
        callback(rate)
      } catch {
        // swallow transient errors in polling loop
      }
    }, WATCH_INTERVAL_MS)

    return () => clearInterval(id)
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.#exchange.close()
  }
}

// ─── Mappers ─────────────────────────────────────────────────────

function mapOrder(order: any): BinanceOrderResult {
  return {
    orderId: order.id,
    status: order.status,
    price: order.price ?? 0,
    size: order.amount ?? 0,
    fee: order.fee?.cost ?? 0,
  }
}

function mapPosition(p: any): BinancePosition {
  return {
    symbol: p.symbol,
    side: (p.side === 'long' ? 'LONG' : 'SHORT') as OrderSide,
    entryPrice: p.entryPrice ?? 0,
    size: p.contracts ?? p.amount ?? 0,
    leverage: p.leverage ?? 1,
    unrealizedPnl: p.unrealizedPnl ?? 0,
    liquidationPrice: p.liquidationPrice ?? 0,
  }
}
