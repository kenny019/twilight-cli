import type {
  TwilightClient,
  TwilightAccount,
  TwilightTradeResult,
  TwilightTradeQuery,
  TwilightLendPool,
  TwilightMarketData,
  OrderSide,
  OrderType,
} from '../types/index.js'
import type { SandboxClock } from './clock.js'

interface VirtualPosition {
  side: OrderSide
  entryPrice: number
  leverage: number
  openedAt: string
}

interface VirtualAccount {
  index: number
  balance: number
  ioType: 'Coin' | 'Order' | 'Lend'
  position: VirtualPosition | null
}

let requestCounter = 0
function mockRequestId(): string {
  return `mock-${++requestCounter}`
}

function ok(accountIndex: number): TwilightTradeResult {
  return { requestId: mockRequestId(), accountIndex, status: 'success' }
}

export class MockTwilightClient implements TwilightClient {
  private accounts: Map<number, VirtualAccount> = new Map()
  private nextAccountIndex = 0
  private walletSats: number
  private walletNyks = 0

  constructor(
    private clock: SandboxClock,
    initialBalanceSats = 1_000_000,
  ) {
    this.walletSats = initialBalanceSats
  }

  // ─── Market data (reads from clock) ─────────────────────────

  async marketPrice(): Promise<number> {
    return this.clock.current().price
  }

  async fundingRate(): Promise<number> {
    return this.clock.current().twilightFundingRate
  }

  async feeRate(): Promise<TwilightMarketData['feeRate']> {
    return { marketFill: 0.0005, limitFill: 0.0002, marketSettle: 0.0005, limitSettle: 0.0002 }
  }

  async marketStats(): Promise<Record<string, unknown>> {
    const d = this.clock.current()
    return {
      price: d.price,
      fundingRate: d.twilightFundingRate,
      volume: d.volume ?? 0,
      volatility: d.volatility ?? 0,
    }
  }

  async lendPool(): Promise<TwilightLendPool> {
    const d = this.clock.current()
    return { totalDeposits: 50_000_000, shareValue: 1.0, apy: d.lendingApy ?? 0 }
  }

  async lastDayApy(): Promise<number> {
    return this.clock.current().lendingApy ?? 0
  }

  async orderbook(): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }> {
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

  // ─── Wallet ────────────────────────────────────────────────

  async walletBalance(): Promise<{ nyks: number; sats: number }> {
    return { nyks: this.walletNyks, sats: this.walletSats }
  }

  async walletAccounts(): Promise<TwilightAccount[]> {
    return Array.from(this.accounts.values()).map((a) => ({
      index: a.index,
      balance: a.balance,
      onChain: true,
      ioType: a.ioType,
    }))
  }

  // ─── ZkAccount operations ─────────────────────────────────

  async fund(amountSats: number): Promise<TwilightTradeResult> {
    if (amountSats > this.walletSats) throw new Error('Insufficient wallet balance')
    this.walletSats -= amountSats
    const index = this.nextAccountIndex++
    this.accounts.set(index, { index, balance: amountSats, ioType: 'Coin', position: null })
    return ok(index)
  }

  async withdraw(accountIndex: number): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(accountIndex)
    this.walletSats += acct.balance
    this.accounts.delete(accountIndex)
    return ok(accountIndex)
  }

  async transfer(fromAccountIndex: number): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(fromAccountIndex)
    this.accounts.delete(fromAccountIndex)
    const newIndex = this.nextAccountIndex++
    this.accounts.set(newIndex, { ...acct, index: newIndex })
    return ok(newIndex)
  }

  async split(fromAccountIndex: number, balancesSats: number[]): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(fromAccountIndex)
    const total = balancesSats.reduce((s, b) => s + b, 0)
    if (total > acct.balance) throw new Error('Split amounts exceed account balance')
    this.accounts.delete(fromAccountIndex)

    let firstIndex = -1
    for (const bal of balancesSats) {
      const idx = this.nextAccountIndex++
      if (firstIndex === -1) firstIndex = idx
      this.accounts.set(idx, { index: idx, balance: bal, ioType: 'Coin', position: null })
    }
    return ok(firstIndex)
  }

  // ─── Trading ──────────────────────────────────────────────

  async openTrade(
    accountIndex: number,
    side: OrderSide,
    entryPrice: number,
    leverage: number,
    _orderType?: OrderType,
  ): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(accountIndex)
    if (acct.ioType !== 'Coin') throw new Error(`Account ${accountIndex} is not a Coin account`)
    acct.ioType = 'Order'
    acct.position = { side, entryPrice, leverage, openedAt: this.clock.timestamp() }
    return ok(accountIndex)
  }

  async closeTrade(
    accountIndex: number,
    _options?: { stopLoss?: number; takeProfit?: number },
  ): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(accountIndex)
    if (!acct.position) throw new Error(`Account ${accountIndex} has no open position`)

    const currentPrice = this.clock.current().price
    const { side, entryPrice, leverage } = acct.position

    let pnl: number
    if (side === 'LONG') {
      pnl = ((currentPrice - entryPrice) / entryPrice) * acct.balance * leverage
    } else {
      pnl = ((entryPrice - currentPrice) / entryPrice) * acct.balance * leverage
    }

    acct.balance = Math.max(0, acct.balance + pnl)
    acct.ioType = 'Coin'
    acct.position = null
    return ok(accountIndex)
  }

  async cancelTrade(accountIndex: number): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(accountIndex)
    if (acct.position) {
      acct.ioType = 'Coin'
      acct.position = null
    }
    return ok(accountIndex)
  }

  async queryTrade(accountIndex: number): Promise<TwilightTradeQuery> {
    const acct = this.requireAccount(accountIndex)
    const orderStatus = acct.position ? 'FILLED' : 'UNKNOWN'
    return {
      orderStatus,
      raw: {
        accountIndex,
        ioType: acct.ioType,
        balance: acct.balance,
        position: acct.position ? { ...acct.position } : null,
      },
    }
  }

  async unlockTrade(accountIndex: number): Promise<TwilightTradeResult> {
    this.requireAccount(accountIndex)
    return ok(accountIndex)
  }

  async waitForOrderStatus(accountIndex: number, target: 'FILLED' | 'SETTLED'): Promise<'FILLED' | 'SETTLED' | 'PENDING' | 'CANCELLED' | 'LIQUIDATED' | 'UNKNOWN'> {
    this.requireAccount(accountIndex)
    return target
  }

  // ─── Lending ──────────────────────────────────────────────

  async openLend(accountIndex: number): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(accountIndex)
    if (acct.ioType !== 'Coin') throw new Error(`Account ${accountIndex} is not a Coin account`)
    acct.ioType = 'Lend'
    return ok(accountIndex)
  }

  async closeLend(accountIndex: number): Promise<TwilightTradeResult> {
    const acct = this.requireAccount(accountIndex)
    if (acct.ioType !== 'Lend') throw new Error(`Account ${accountIndex} is not a Lend account`)
    // Apply a small yield based on lending APY
    const apy = this.clock.current().lendingApy ?? 0
    const yieldAmount = acct.balance * (apy / 100 / 365)
    acct.balance += yieldAmount
    acct.ioType = 'Coin'
    return ok(accountIndex)
  }

  async queryLend(accountIndex: number): Promise<Record<string, unknown>> {
    const acct = this.requireAccount(accountIndex)
    return {
      accountIndex,
      ioType: acct.ioType,
      balance: acct.balance,
      apy: this.clock.current().lendingApy ?? 0,
    }
  }

  // ─── Helpers (for test assertions) ────────────────────────

  getAccount(index: number): VirtualAccount | undefined {
    return this.accounts.get(index)
  }

  getTotalBalance(): number {
    let total = this.walletSats
    for (const acct of this.accounts.values()) {
      total += acct.balance
    }
    return total
  }

  // ─── Internal ─────────────────────────────────────────────

  private requireAccount(index: number): VirtualAccount {
    const acct = this.accounts.get(index)
    if (!acct) throw new Error(`Account ${index} not found`)
    return acct
  }
}
