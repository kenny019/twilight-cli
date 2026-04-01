/**
 * Validation contract for WS-9: Template Strategies
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FundingArbStrategy } from '../templates/funding-arb.js'
import { LendingYieldStrategy } from '../templates/lending-yield.js'
import type { Strategy, Context, TwilightClient, BinanceClient, RiskManager, AlertClient, Logger, Database } from '../../types/index.js'

function createMockContext(): Context {
  return {
    twilight: {
      walletBalance: vi.fn().mockResolvedValue({ nyks: 1000, sats: 100000 }),
      walletAccounts: vi.fn().mockResolvedValue([{ index: 0, balance: 50000, onChain: true, ioType: 'Coin' }]),
      fund: vi.fn().mockResolvedValue({ requestId: 'R1', accountIndex: 0, status: 'success' }),
      withdraw: vi.fn().mockResolvedValue({ requestId: 'R2', accountIndex: 0, status: 'success' }),
      transfer: vi.fn().mockResolvedValue({ requestId: 'R3', accountIndex: 1, status: 'success' }),
      split: vi.fn().mockResolvedValue({ requestId: 'R4', accountIndex: 0, status: 'success' }),
      openTrade: vi.fn().mockResolvedValue({ requestId: 'R5', accountIndex: 0, status: 'FILLED' }),
      closeTrade: vi.fn().mockResolvedValue({ requestId: 'R6', accountIndex: 0, status: 'SETTLED' }),
      cancelTrade: vi.fn().mockResolvedValue({ requestId: 'R7', accountIndex: 0, status: 'CANCELLED' }),
      queryTrade: vi.fn().mockResolvedValue({ uuid: 'T1', status: 'FILLED' }),
      unlockTrade: vi.fn().mockResolvedValue({ requestId: 'R8', accountIndex: 0, status: 'success' }),
      openLend: vi.fn().mockResolvedValue({ requestId: 'R9', accountIndex: 0, status: 'success' }),
      closeLend: vi.fn().mockResolvedValue({ requestId: 'R10', accountIndex: 0, status: 'success' }),
      queryLend: vi.fn().mockResolvedValue({ uuid: 'L1', status: 'ACTIVE' }),
      marketPrice: vi.fn().mockResolvedValue(65000),
      fundingRate: vi.fn().mockResolvedValue(0.0),
      feeRate: vi.fn().mockResolvedValue({ marketFill: 0.04, limitFill: 0.02, marketSettle: 0.04, limitSettle: 0.02 }),
      marketStats: vi.fn().mockResolvedValue({}),
      lendPool: vi.fn().mockResolvedValue({ totalDeposits: 500000, shareValue: 1.05, apy: 18.0 }),
      lastDayApy: vi.fn().mockResolvedValue(18.0),
      orderbook: vi.fn().mockResolvedValue({ bids: [[65000, 1]], asks: [[65100, 2]] }),
    } as TwilightClient,
    binance: {
      getPrice: vi.fn().mockResolvedValue(65050),
      getFundingRate: vi.fn().mockResolvedValue(0.0003),
      getOrderbook: vi.fn().mockResolvedValue({ bids: [[65050, 10]], asks: [[65100, 10]] }),
      openPosition: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'closed', price: 65050, size: 0.15, fee: 0.026 }),
      closePosition: vi.fn().mockResolvedValue({ orderId: 'B2', status: 'closed', price: 65100, size: 0.15, fee: 0.026 }),
      getPosition: vi.fn().mockResolvedValue(null),
      getPositions: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(0.5),
      getMarginBalance: vi.fn().mockResolvedValue(32500),
      watchPrice: vi.fn().mockResolvedValue(() => {}),
      watchFundingRate: vi.fn().mockResolvedValue(() => {}),
      close: vi.fn().mockResolvedValue(undefined),
    } as BinanceClient,
    risk: {
      checkPreTrade: vi.fn().mockResolvedValue({ allowed: true }),
      checkDrawdown: vi.fn().mockResolvedValue({ allowed: true }),
      checkDailyLoss: vi.fn().mockResolvedValue({ allowed: true }),
      checkCooldown: vi.fn().mockResolvedValue({ allowed: true }),
      isKillSwitchActive: vi.fn().mockResolvedValue(false),
      activateKillSwitch: vi.fn(),
      deactivateKillSwitch: vi.fn(),
      recordTrade: vi.fn(),
      checkConnectionHealth: vi.fn().mockResolvedValue({ allowed: true }),
      reportConnectionStatus: vi.fn(),
    } as RiskManager,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as Logger,
    db: {
      createStrategy: vi.fn().mockReturnValue({ id: 's1' }),
      getStrategy: vi.fn(),
      updateStrategy: vi.fn(),
      listStrategies: vi.fn().mockReturnValue([]),
      createPosition: vi.fn().mockReturnValue({ id: 'p1', openedAt: new Date().toISOString(), closedAt: null }),
      getPosition: vi.fn(),
      updatePosition: vi.fn(),
      listPositions: vi.fn().mockReturnValue([]),
      createTrade: vi.fn().mockReturnValue({ id: 't1', executedAt: new Date().toISOString() }),
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
}

describe('WS-9: Template Strategies', () => {
  describe('FundingArbStrategy', () => {
    let strategy: Strategy
    let ctx: Context

    beforeEach(async () => {
      ctx = createMockContext()
      strategy = new FundingArbStrategy()
      await strategy.init({
        entryThreshold: 0.0002,
        exitThreshold: 0.0001,
        positionSizeSats: 50000,
        checkIntervalMs: 60000,
      }, ctx)
    })

    it('implements Strategy interface', () => {
      expect(strategy.id).toBeTruthy()
      expect(strategy.name).toBeTruthy()
      expect(strategy.description).toBeTruthy()
      expect(strategy.configSchema).toBeTruthy()
      expect(typeof strategy.init).toBe('function')
      expect(typeof strategy.tick).toBe('function')
      expect(typeof strategy.stop).toBe('function')
      expect(typeof strategy.status).toBe('function')
    })

    it('has a valid configSchema (JSON Schema)', () => {
      expect(strategy.configSchema).toHaveProperty('type', 'object')
      expect(strategy.configSchema).toHaveProperty('properties')
    })

    it('tick checks funding rate differential between Twilight and Binance', async () => {
      await strategy.tick()
      // Should have queried both exchanges for funding rates
      expect(ctx.twilight.fundingRate).toHaveBeenCalled()
      expect(ctx.binance.getFundingRate).toHaveBeenCalled()
    })

    it('opens delta-neutral position when rate exceeds entry threshold', async () => {
      // Set Twilight rate to 0% and Binance rate to 0.05% (high differential)
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.0)
      ;(ctx.binance.getFundingRate as any).mockResolvedValue(0.0005)

      await strategy.tick()

      // Should have opened positions on both exchanges
      expect(ctx.twilight.openTrade).toHaveBeenCalled()
      expect(ctx.binance.openPosition).toHaveBeenCalled()
    })

    it('does not open position when rate is below threshold', async () => {
      // Small differential — below threshold
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.0)
      ;(ctx.binance.getFundingRate as any).mockResolvedValue(0.00005)

      await strategy.tick()

      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
      expect(ctx.binance.openPosition).not.toHaveBeenCalled()
    })

    it('respects risk manager pre-trade check', async () => {
      ;(ctx.risk.checkPreTrade as any).mockResolvedValue({ allowed: false, reason: 'Position size exceeds cap', control: 'positionSizeCap' })
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.0)
      ;(ctx.binance.getFundingRate as any).mockResolvedValue(0.001) // High rate to trigger entry

      await strategy.tick()

      // Should NOT have opened positions because risk check failed
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('closes positions when rate normalizes', async () => {
      // First tick: open position (high rate)
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.0)
      ;(ctx.binance.getFundingRate as any).mockResolvedValue(0.0005)
      await strategy.tick()

      // Simulate open positions
      ;(ctx.binance.getPosition as any).mockResolvedValue({
        symbol: 'BTC/USDT:USDT', side: 'SHORT', entryPrice: 65000, size: 0.15, leverage: 1, unrealizedPnl: 0, liquidationPrice: 0,
      })
      ;(ctx.db.listPositions as any).mockReturnValue([
        { id: 'p1', strategyId: strategy.id, exchange: 'twilight', side: 'LONG', status: 'open' },
      ])

      // Second tick: rate normalized
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.0)
      ;(ctx.binance.getFundingRate as any).mockResolvedValue(0.00005) // Below exit threshold
      await strategy.tick()

      // Should close positions
      expect(ctx.twilight.closeTrade).toHaveBeenCalled()
      expect(ctx.binance.closePosition).toHaveBeenCalled()
    })

    it('responds to stop() gracefully', async () => {
      await expect(strategy.stop()).resolves.toBeUndefined()
    })

    it('returns valid status', () => {
      const info = strategy.status()
      expect(info.id).toBe(strategy.id)
      expect(['active', 'stopped', 'error']).toContain(info.status)
    })
  })

  describe('LendingYieldStrategy', () => {
    let strategy: Strategy
    let ctx: Context

    beforeEach(async () => {
      ctx = createMockContext()
      strategy = new LendingYieldStrategy()
      await strategy.init({
        minApyThreshold: 10.0,
        rebalanceThreshold: 5.0,
        checkIntervalMs: 300000,
      }, ctx)
    })

    it('implements Strategy interface', () => {
      expect(strategy.id).toBeTruthy()
      expect(strategy.name).toBeTruthy()
      expect(typeof strategy.tick).toBe('function')
      expect(typeof strategy.stop).toBe('function')
    })

    it('has a valid configSchema', () => {
      expect(strategy.configSchema).toHaveProperty('type', 'object')
    })

    it('tick checks lending pool APY', async () => {
      await strategy.tick()
      expect(ctx.twilight.lastDayApy).toHaveBeenCalled()
    })

    it('deploys to lending pool when APY is above minimum', async () => {
      ;(ctx.twilight.lastDayApy as any).mockResolvedValue(18.0) // Above 10% min
      ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
        { index: 0, balance: 50000, onChain: true, ioType: 'Coin' },
      ])

      await strategy.tick()

      // Should deploy idle funds to lending
      expect(ctx.twilight.openLend).toHaveBeenCalled()
    })

    it('withdraws from lending when APY drops below minimum', async () => {
      // Simulate active lend position
      ;(ctx.twilight.lastDayApy as any).mockResolvedValue(5.0) // Below 10% min
      ;(ctx.twilight.queryLend as any).mockResolvedValue({ uuid: 'L1', status: 'ACTIVE' })
      ;(ctx.db.listPositions as any).mockReturnValue([
        { id: 'p1', strategyId: strategy.id, exchange: 'twilight', status: 'open' },
      ])

      await strategy.tick()

      expect(ctx.twilight.closeLend).toHaveBeenCalled()
    })

    it('does not deploy when APY is below minimum', async () => {
      ;(ctx.twilight.lastDayApy as any).mockResolvedValue(5.0) // Below threshold
      ;(ctx.db.listPositions as any).mockReturnValue([]) // No active lend

      await strategy.tick()

      expect(ctx.twilight.openLend).not.toHaveBeenCalled()
    })

    it('responds to stop() gracefully', async () => {
      await expect(strategy.stop()).resolves.toBeUndefined()
    })

    it('returns valid status', () => {
      const info = strategy.status()
      expect(info.id).toBe(strategy.id)
    })
  })
})
