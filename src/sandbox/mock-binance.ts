import type {
  BinanceClient,
  BinancePosition,
  BinanceOrderResult,
  OrderSide,
  OrderType,
} from '../types/index.js'
import type { SandboxClock } from './clock.js'

let orderCounter = 0
function mockOrderId(): string {
  return `mock-${++orderCounter}`
}

export class MockBinanceClient implements BinanceClient {
  private position: BinancePosition | null = null
  private balance: number // in BTC
  private marginBalance: number // in USD

  constructor(
    private clock: SandboxClock,
    initialBalanceBtc = 0.5,
  ) {
    this.balance = initialBalanceBtc
    this.marginBalance = initialBalanceBtc * clock.current().price
  }

  // ─── Market data ──────────────────────────────────────────

  async getPrice(_symbol?: string): Promise<number> {
    return this.clock.current().price
  }

  async getFundingRate(_symbol?: string): Promise<number> {
    return this.clock.current().binanceFundingRate
  }

  async getOrderbook(
    _symbol?: string,
  ): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }> {
    const price = this.clock.current().price
    const bids: Array<[number, number]> = []
    const asks: Array<[number, number]> = []
    for (let i = 1; i <= 5; i++) {
      const spread = price * 0.0001 * i
      const size = 1.0 / i
      bids.push([price - spread, size])
      asks.push([price + spread, size])
    }
    return { bids, asks }
  }

  // ─── Trading ──────────────────────────────────────────────

  async openPosition(
    side: OrderSide,
    size: number,
    leverage: number,
    _orderType?: OrderType,
  ): Promise<BinanceOrderResult> {
    const price = this.clock.current().price
    this.position = {
      symbol: 'BTCUSDT',
      side,
      entryPrice: price,
      size,
      leverage,
      unrealizedPnl: 0,
      liquidationPrice:
        side === 'LONG' ? price * (1 - 1 / leverage) : price * (1 + 1 / leverage),
    }
    return { orderId: mockOrderId(), status: 'closed', price, size, fee: 0 }
  }

  async closePosition(_side: OrderSide, size: number): Promise<BinanceOrderResult> {
    const price = this.clock.current().price
    if (!this.position) throw new Error('No open position to close')

    const { side, entryPrice, leverage } = this.position
    let pnl: number
    if (side === 'LONG') {
      pnl = ((price - entryPrice) / entryPrice) * size * leverage
    } else {
      pnl = ((entryPrice - price) / entryPrice) * size * leverage
    }

    this.balance += pnl / price // convert USD PnL back to BTC
    this.marginBalance += pnl
    this.position = null

    return { orderId: mockOrderId(), status: 'closed', price, size, fee: 0 }
  }

  async getPosition(_symbol?: string): Promise<BinancePosition | null> {
    if (!this.position) return null
    // Update unrealized PnL
    const price = this.clock.current().price
    const { side, entryPrice, size, leverage } = this.position
    if (side === 'LONG') {
      this.position.unrealizedPnl = ((price - entryPrice) / entryPrice) * size * leverage
    } else {
      this.position.unrealizedPnl = ((entryPrice - price) / entryPrice) * size * leverage
    }
    return { ...this.position }
  }

  async getPositions(): Promise<BinancePosition[]> {
    const pos = await this.getPosition()
    return pos ? [pos] : []
  }

  // ─── Account ──────────────────────────────────────────────

  async getBalance(): Promise<number> {
    return this.balance
  }

  async getMarginBalance(): Promise<number> {
    return this.marginBalance
  }

  // ─── WebSocket stubs (no-op in sandbox) ───────────────────

  async watchPrice(_callback: (price: number) => void): Promise<() => void> {
    return () => {}
  }

  async watchFundingRate(_callback: (rate: number) => void): Promise<() => void> {
    return () => {}
  }

  // ─── Lifecycle ────────────────────────────────────────────

  async close(): Promise<void> {
    // no-op
  }
}
