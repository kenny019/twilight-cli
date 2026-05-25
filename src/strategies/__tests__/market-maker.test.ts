import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MarketMakerStrategy } from '../templates/market-maker.js'
import type {
  Context,
  TwilightClient,
  BinanceClient,
  RiskManager,
  AlertClient,
  Logger,
  Database,
  TwilightAccount,
} from '../../types/index.js'

interface MockState {
  accounts: TwilightAccount[]
  balance: { nyks: number; sats: number }
  price: number
  killSwitch: boolean
  positions: Array<{ id: string; strategyId: string; status: string; side: 'LONG' | 'SHORT'; size: number }>
}

function makeContext(overrides?: Partial<MockState>): { ctx: Context; state: MockState } {
  const state: MockState = {
    accounts: [
      { index: 0, balance: 10_000, onChain: true, ioType: 'Coin' },
      { index: 1, balance: 10_000, onChain: true, ioType: 'Coin' },
      { index: 2, balance: 10_000, onChain: true, ioType: 'Coin' },
      { index: 3, balance: 10_000, onChain: true, ioType: 'Coin' },
    ],
    balance: { nyks: 10_000, sats: 1_000_000 },
    price: 80_000,
    killSwitch: false,
    positions: [],
    ...overrides,
  }

  let positionCounter = 0

  const ctx: Context = {
    twilight: {
      walletBalance: vi.fn(async () => state.balance),
      walletAccounts: vi.fn(async () => [...state.accounts]),
      fund: vi.fn(),
      withdraw: vi.fn(),
      transfer: vi.fn(),
      split: vi.fn(),
      openTrade: vi.fn(async (idx: number) => {
        const acct = state.accounts.find(a => a.index === idx)
        if (acct) acct.ioType = 'Memo'
        return { requestId: `R-${idx}`, accountIndex: idx, status: 'PENDING' }
      }),
      closeTrade: vi.fn(async (idx: number) => ({ requestId: `C-${idx}`, accountIndex: idx, status: 'SETTLED' })),
      cancelTrade: vi.fn(async (idx: number) => {
        const acct = state.accounts.find(a => a.index === idx)
        if (acct) acct.ioType = 'Coin'
        return { requestId: `X-${idx}`, accountIndex: idx, status: 'CANCELLED' }
      }),
      queryTrade: vi.fn(async () => ({ orderStatus: 'PENDING' as const, raw: {} })),
      unlockTrade: vi.fn(),
      openLend: vi.fn(),
      closeLend: vi.fn(),
      queryLend: vi.fn(),
      marketPrice: vi.fn(async () => state.price),
      fundingRate: vi.fn(async () => 0),
      feeRate: vi.fn(async () => ({ marketFill: 0.04, limitFill: 0.02, marketSettle: 0.04, limitSettle: 0.02 })),
      marketStats: vi.fn(),
      lendPool: vi.fn(),
      lastDayApy: vi.fn(),
      orderbook: vi.fn(),
    } as unknown as TwilightClient,
    binance: {} as BinanceClient,
    risk: {
      isKillSwitchActive: vi.fn(async () => state.killSwitch),
      activateKillSwitch: vi.fn(async () => { state.killSwitch = true }),
      deactivateKillSwitch: vi.fn(async () => { state.killSwitch = false }),
      checkPreTrade: vi.fn(),
      checkDrawdown: vi.fn(),
      checkDailyLoss: vi.fn(),
      checkCooldown: vi.fn(),
      recordTrade: vi.fn(),
      checkConnectionHealth: vi.fn(),
      reportConnectionStatus: vi.fn(),
    } as unknown as RiskManager,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as Logger,
    db: {
      listPositions: vi.fn(({ status }: { strategyId?: string; status?: string } = {}) =>
        state.positions.filter(p => !status || p.status === status),
      ),
      createPosition: vi.fn((data: { side: 'LONG' | 'SHORT'; size: number; strategyId: string }) => {
        positionCounter++
        const record = { id: `p${positionCounter}`, strategyId: data.strategyId, status: 'open', side: data.side, size: data.size }
        state.positions.push(record)
        return record
      }),
      updatePosition: vi.fn((id: string, data: { status?: string }) => {
        const pos = state.positions.find(p => p.id === id)
        if (pos && data.status) pos.status = data.status
        return pos
      }),
      createTrade: vi.fn(),
      createStrategy: vi.fn(),
      getStrategy: vi.fn(),
      updateStrategy: vi.fn(),
      listStrategies: vi.fn().mockReturnValue([]),
      getPosition: vi.fn(),
      listTrades: vi.fn().mockReturnValue([]),
      createAccount: vi.fn(),
      getAccount: vi.fn(),
      updateAccount: vi.fn(),
      listAccounts: vi.fn().mockReturnValue([]),
      createAlert: vi.fn(),
      listAlerts: vi.fn().mockReturnValue([]),
      getKV: vi.fn(),
      setKV: vi.fn(),
    } as unknown as Database,
    alert: {
      send: vi.fn().mockResolvedValue(true),
      sendTradeAlert: vi.fn().mockResolvedValue(true),
      sendErrorAlert: vi.fn().mockResolvedValue(true),
      sendRiskAlert: vi.fn().mockResolvedValue(true),
    } as AlertClient,
  }

  return { ctx, state }
}

const baseConfig = {
  layers: 2,
  layerStepBps: 50,
  quoteSizeSats: 10_000,
  requoteIntervalMs: 60_000,
  requoteBps: 25,
  maxQuoteAgeMs: 180_000,
  leverage: 1,
  maxInventorySats: 30_000,
  walletFloorSats: 500_000,
  bypassCooldown: true,
  minNyks: 1000,
}

describe('MarketMakerStrategy', () => {
  let strategy: MarketMakerStrategy
  let ctx: Context
  let state: MockState

  beforeEach(async () => {
    ;({ ctx, state } = makeContext())
    strategy = new MarketMakerStrategy()
    await strategy.init(baseConfig, ctx)
  })

  it('posts layered quotes at mid ± k*step', async () => {
    await strategy.tick()
    const calls = (ctx.twilight.openTrade as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBe(4)

    const prices = calls.map(c => ({ side: c[1], price: c[2] })).sort((a, b) => a.price - b.price)
    // mid 80000, step 50bps: bids 79600, 79200; asks 80400, 80800
    expect(prices.map(p => p.price)).toEqual([79200, 79600, 80400, 80800])
    const longPrices = prices.filter(p => p.side === 'LONG').map(p => p.price)
    const shortPrices = prices.filter(p => p.side === 'SHORT').map(p => p.price)
    expect(longPrices.sort((a, b) => a - b)).toEqual([79200, 79600])
    expect(shortPrices.sort((a, b) => a - b)).toEqual([80400, 80800])
  })

  it('suppresses buy quotes when net inventory above cap', async () => {
    state.positions.push({ id: 'p-pre', strategyId: 'market-maker', status: 'open', side: 'LONG', size: 50_000 })
    // Re-init so inventory is rebuilt from DB
    strategy = new MarketMakerStrategy()
    await strategy.init(baseConfig, ctx)

    await strategy.tick()
    const calls = (ctx.twilight.openTrade as ReturnType<typeof vi.fn>).mock.calls
    const sides = calls.map(c => c[1])
    expect(sides).not.toContain('LONG')
    expect(sides.filter(s => s === 'SHORT').length).toBeGreaterThan(0)
  })

  it('suppresses sell quotes when net inventory below negative cap', async () => {
    state.positions.push({ id: 'p-pre', strategyId: 'market-maker', status: 'open', side: 'SHORT', size: 50_000 })
    strategy = new MarketMakerStrategy()
    await strategy.init(baseConfig, ctx)

    await strategy.tick()
    const calls = (ctx.twilight.openTrade as ReturnType<typeof vi.fn>).mock.calls
    const sides = calls.map(c => c[1])
    expect(sides).not.toContain('SHORT')
    expect(sides.filter(s => s === 'LONG').length).toBeGreaterThan(0)
  })

  it('concurrent tick guard prevents overlapping ticks', async () => {
    // Hold tick 1 inside walletBalance so the second invocation runs while
    // tick 1 is still in flight.
    let resolveBalance!: () => void
    const balanceMock = ctx.twilight.walletBalance as ReturnType<typeof vi.fn>
    balanceMock.mockImplementationOnce(() =>
      new Promise<{ nyks: number; sats: number }>(resolve => {
        resolveBalance = () => resolve(state.balance)
      }),
    )

    const t1 = strategy.tick()
    const t2 = strategy.tick()
    await t2 // returns immediately because tickInFlight is set
    resolveBalance()
    await t1

    expect(balanceMock.mock.calls.length).toBe(1)
  })

  it('detects fill via queryTrade.orderStatus and persists position', async () => {
    await strategy.tick()
    // After first tick, all 4 accounts are Memo with quoteState entries.
    expect((ctx.twilight.openTrade as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4)

    // One account's queryTrade now reports FILLED (account stays in Memo on
    // Twilight even after fill — only the order_status changes).
    ;(ctx.twilight.queryTrade as ReturnType<typeof vi.fn>).mockImplementation(async (idx: number) => {
      if (idx === 0) return { orderStatus: 'FILLED', raw: {} }
      return { orderStatus: 'PENDING', raw: {} }
    })
    ;(ctx.twilight.marketPrice as ReturnType<typeof vi.fn>).mockResolvedValue(80_000)

    await strategy.tick()

    expect((ctx.db.createPosition as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
    const persistedPositions = (ctx.db.createPosition as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .filter((p: { status: string }) => p.status === 'open')
    expect(persistedPositions.length).toBeGreaterThanOrEqual(1)
  })

  it('boot recovery cancels PENDING and closes FILLED orders', async () => {
    // Reset and re-create with pre-existing non-Coin accounts
    ;({ ctx, state } = makeContext({
      accounts: [
        { index: 5, balance: 10_000, onChain: true, ioType: 'Memo' }, // PENDING quote
        { index: 6, balance: 10_000, onChain: true, ioType: 'Trade' }, // FILLED position
        { index: 7, balance: 10_000, onChain: true, ioType: 'Coin' },
      ],
    }))
    ;(ctx.twilight.queryTrade as ReturnType<typeof vi.fn>).mockImplementation(async (idx: number) => {
      if (idx === 5) return { orderStatus: 'PENDING', raw: {} }
      if (idx === 6) return { orderStatus: 'FILLED', raw: {} }
      return { orderStatus: 'UNKNOWN', raw: {} }
    })

    const fresh = new MarketMakerStrategy()
    await fresh.init(baseConfig, ctx)

    expect((ctx.twilight.cancelTrade as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toContain(5)
    expect((ctx.twilight.closeTrade as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toContain(6)
  })

  it('activates killswitch when wallet falls below floor', async () => {
    state.balance.sats = 400_000 // below 500_000 floor
    await strategy.tick()
    expect(ctx.risk.activateKillSwitch).toHaveBeenCalled()
    expect(ctx.alert.send).toHaveBeenCalled()
  })

  it('activates killswitch when NYKS falls below gas floor', async () => {
    state.balance.nyks = 500
    await strategy.tick()
    expect(ctx.risk.activateKillSwitch).toHaveBeenCalled()
  })

  it('stop() cancels all active quotes', async () => {
    await strategy.tick()
    // Reset cancel mock so we only count stop-time cancels
    ;(ctx.twilight.cancelTrade as ReturnType<typeof vi.fn>).mockClear()
    await strategy.stop()
    expect((ctx.twilight.cancelTrade as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})
