/**
 * Validation contract for WS-9: Template Strategies
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FundingArbStrategy, computeRoundTripPnl } from '../templates/funding-arb.js'
import { LendingYieldStrategy } from '../templates/lending-yield.js'
import type { Strategy, Context, TwilightClient, BinanceClient, HyperliquidClient, RiskManager, AlertClient, Logger, Database } from '../../types/index.js'
import type { ProposableStrategy, AgentEvaluation } from '../../types/agent.js'

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
      queryTrade: vi.fn().mockResolvedValue({ orderStatus: 'FILLED', raw: { uuid: 'T1', status: 'FILLED' } }),
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
    hyperliquid: {
      getMarkPrice: vi.fn().mockResolvedValue(65000),
      getFundingRate: vi.fn().mockResolvedValue(0.0000125),
      openPosition: vi.fn().mockResolvedValue({ orderId: 1, status: 'filled', fillPrice: 65010, size: 0.0002, fee: 0, raw: {} }),
      closePosition: vi.fn().mockResolvedValue({ orderId: 2, status: 'filled', fillPrice: 65020, size: 0.0002, fee: 0, raw: {} }),
      getPosition: vi.fn().mockResolvedValue(null),
      getBalance: vi.fn().mockResolvedValue(50),
      getRealizedFunding: vi.fn().mockResolvedValue([]),
      quantizeBtcSize: vi.fn((sats: number, mark: number) => {
        const step = 0.00001
        const raw = sats / 1e8
        return Math.max(Math.ceil(raw / step) * step, Math.ceil((10 / mark) / step) * step)
      }),
    } as unknown as HyperliquidClient,
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

    // Helper: avoid the payment-window gate by stubbing time to mid-hour
    function freezeMidHour() {
      const now = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 1_200_000 // :20 past
      vi.useFakeTimers()
      vi.setSystemTime(new Date(now))
    }
    function unfreeze() { vi.useRealTimers() }

    beforeEach(async () => {
      ctx = createMockContext()
      // Dedicated accounts must exist and have balance
      ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
        { index: 2, balance: 50_000, onChain: true, ioType: 'Coin' },
        { index: 3, balance: 50_000, onChain: true, ioType: 'Coin' },
      ])
      strategy = new FundingArbStrategy()
      await strategy.init({
        entryThreshold: 0.01,
        exitThreshold: 0.002,
        positionSizeSats: 13_000,
        checkIntervalMs: 60_000,
        dedicatedAccountIndices: [2, 3],
        maxConsecutiveFailures: 3,
        minHoldUntilNextFundingMs: 600_000,
        maxHoldMs: 86_400_000,
        hyperliquidLeverage: 1,
        hyperliquidMarginBufferUsdc: 5,
      }, ctx)
    })

    afterEach(() => unfreeze())

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

    it('tick checks funding rate differential between Twilight and Hyperliquid', async () => {
      freezeMidHour()
      await strategy.tick()
      expect(ctx.twilight.fundingRate).toHaveBeenCalled()
      expect(ctx.hyperliquid!.getFundingRate).toHaveBeenCalled()
    })

    it('opens SHORT-Twilight + LONG-Hyperliquid when Twilight rate is much higher (signedDiff > 0)', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0000125)

      await strategy.tick()

      expect(ctx.twilight.openTrade).toHaveBeenCalledWith(2, 'SHORT', expect.any(Number), 1)
      expect(ctx.hyperliquid!.openPosition).toHaveBeenCalledWith('LONG', expect.any(Number), 1)
    })

    it('opens LONG-Twilight + SHORT-Hyperliquid when Twilight rate is much lower (signedDiff < 0)', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(-0.05)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0000125)

      await strategy.tick()

      expect(ctx.twilight.openTrade).toHaveBeenCalledWith(2, 'LONG', expect.any(Number), 1)
      expect(ctx.hyperliquid!.openPosition).toHaveBeenCalledWith('SHORT', expect.any(Number), 1)
    })

    it('does not open position when |signedDiff| is below entry threshold', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.001)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0000125)

      await strategy.tick()

      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
      expect(ctx.hyperliquid!.openPosition).not.toHaveBeenCalled()
    })

    it('respects risk manager pre-trade check', async () => {
      freezeMidHour()
      ;(ctx.risk.checkPreTrade as any).mockResolvedValue({ allowed: false, reason: 'cap', control: 'positionSizeCap' })
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

      await strategy.tick()
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('skips opening when too close to next funding payment', async () => {
      // :55 past — 5 min until next funding, below 10 min minHold
      const now = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_300_000
      vi.useFakeTimers()
      vi.setSystemTime(new Date(now))
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

      await strategy.tick()
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('rejects accounts that are not in dedicatedAccountIndices', async () => {
      freezeMidHour()
      ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
        { index: 0, balance: 50_000, onChain: true, ioType: 'Coin' },   // wrong index
        { index: 5, balance: 50_000, onChain: true, ioType: 'Coin' },   // wrong index
      ])
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

      await strategy.tick()
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('treats empty dedicatedAccountIndices as no-index-filter (uses any eligible Coin account)', async () => {
      freezeMidHour()
      await strategy.init({
        entryThreshold: 0.01, exitThreshold: 0.002,
        positionSizeSats: 13_000, checkIntervalMs: 60_000,
        dedicatedAccountIndices: [], maxConsecutiveFailures: 3,
        minHoldUntilNextFundingMs: 600_000, maxHoldMs: 86_400_000,
        hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      }, ctx)
      ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
        { index: 7, balance: 13_000, onChain: true, ioType: 'Coin' },   // index NOT in [2,3] but list is empty
      ])
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

      await strategy.tick()
      expect(ctx.twilight.openTrade).toHaveBeenCalled()
    })

    it('rejects accounts that are off-chain or non-Coin even within dedicated set', async () => {
      freezeMidHour()
      ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
        { index: 2, balance: 50_000, onChain: false, ioType: 'Coin' },     // off-chain
        { index: 3, balance: 50_000, onChain: true, ioType: 'Memo' },      // wrong ioType
      ])
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

      await strategy.tick()
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('rejects accounts with balance below positionSizeSats', async () => {
      freezeMidHour()
      ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
        { index: 2, balance: 10_000, onChain: true, ioType: 'Coin' },
        { index: 3, balance: 10_000, onChain: true, ioType: 'Coin' },
      ])
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

      await strategy.tick()
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('atomic open: rolls back Hyperliquid leg when Twilight open fails', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      ;(ctx.twilight.openTrade as any).mockRejectedValue(new Error('relayer hung'))

      await strategy.tick()

      // Hyperliquid open was called, then compensating close
      expect(ctx.hyperliquid!.openPosition).toHaveBeenCalledTimes(1)
      expect(ctx.hyperliquid!.closePosition).toHaveBeenCalledTimes(1)
      // No position persisted
      expect(ctx.db.createPosition).not.toHaveBeenCalled()
    })

    it('per-strategy killswitch trips after maxConsecutiveFailures', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      ;(ctx.twilight.openTrade as any).mockRejectedValue(new Error('relayer hung'))

      await strategy.tick()
      await strategy.tick()
      await strategy.tick()

      // After 3 failures strategy is disabled — 4th tick should be inert
      ;(ctx.hyperliquid!.openPosition as any).mockClear()
      await strategy.tick()
      expect(ctx.hyperliquid!.openPosition).not.toHaveBeenCalled()
      expect(strategy.status().status).toBe('error')
    })

    it('atomic close: re-hedges on Hyperliquid when Twilight close fails (naked-leg recovery)', async () => {
      freezeMidHour()
      // First open position
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      await strategy.tick()
      expect(ctx.db.createPosition).toHaveBeenCalled()

      // Now make the close path fail on Twilight side
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.0)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      ;(ctx.twilight.closeTrade as any).mockRejectedValue(new Error('relayer hung on close'))
      ;(ctx.hyperliquid!.openPosition as any).mockClear()

      await strategy.tick()

      // Hyperliquid close fired, then re-hedge open
      expect(ctx.hyperliquid!.closePosition).toHaveBeenCalled()
      expect(ctx.hyperliquid!.openPosition).toHaveBeenCalled()
    })

    it('closes positions when |signedDiff| drops below exit threshold', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      await strategy.tick()

      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.001)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      await strategy.tick()

      expect(ctx.twilight.closeTrade).toHaveBeenCalled()
      expect(ctx.hyperliquid!.closePosition).toHaveBeenCalled()
    })

    it('closes positions when signedDiff flips sign', async () => {
      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      await strategy.tick()
      ;(ctx.twilight.closeTrade as any).mockClear()
      ;(ctx.hyperliquid!.closePosition as any).mockClear()

      // Flip: twilight now negative, hl positive — old SHORT-Twilight now pays funding
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(-0.05)
      ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)
      await strategy.tick()

      expect(ctx.twilight.closeTrade).toHaveBeenCalled()
      expect(ctx.hyperliquid!.closePosition).toHaveBeenCalled()
    })

    it('is inert when ctx.hyperliquid is undefined', async () => {
      const ctx2 = { ...ctx, hyperliquid: undefined }
      const s2 = new FundingArbStrategy()
      await s2.init({
        entryThreshold: 0.01, exitThreshold: 0.002, positionSizeSats: 13_000, checkIntervalMs: 60_000,
        dedicatedAccountIndices: [2, 3], maxConsecutiveFailures: 3, minHoldUntilNextFundingMs: 600_000,
      }, ctx2 as unknown as Context)

      freezeMidHour()
      ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
      await s2.tick()
      expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    })

    it('responds to stop() gracefully', async () => {
      await expect(strategy.stop()).resolves.toBeUndefined()
    })

    it('returns valid status', () => {
      const info = strategy.status()
      expect(info.id).toBe(strategy.id)
      expect(['active', 'stopped', 'error']).toContain(info.status)
    })

    describe('propose/execute split', () => {
      it('implements ProposableStrategy interface', () => {
        const proposable = strategy as unknown as ProposableStrategy
        expect(typeof proposable.propose).toBe('function')
        expect(typeof proposable.execute).toBe('function')
      })

      it('propose returns open proposal when differential exceeds threshold', async () => {
        freezeMidHour()
        ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
        ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

        const proposable = strategy as unknown as Strategy & ProposableStrategy
        const proposal = await proposable.propose(ctx)

        expect(proposal).not.toBeNull()
        expect(proposal!.action).toBe('open')
        expect(proposal!.side).toBe('SHORT')
        expect(proposal!.strategyId).toBe('funding-arb')
        expect(proposal!.marketSnapshot.differential).toBeGreaterThan(0)
        expect(proposal!.marketSnapshot.signedDifferential).toBeGreaterThan(0)
      })

      it('propose returns null when no action needed', async () => {
        freezeMidHour()
        ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.001)
        ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

        const proposable = strategy as unknown as Strategy & ProposableStrategy
        const proposal = await proposable.propose(ctx)

        expect(proposal).toBeNull()
      })

      it('execute opens positions with approve evaluation', async () => {
        freezeMidHour()
        ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
        ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

        const evaluation: AgentEvaluation = { verdict: 'approve', confidence: 0.9, reasoning: 'test' }
        const proposable = strategy as unknown as Strategy & ProposableStrategy
        await proposable.execute(ctx, evaluation)

        expect(ctx.twilight.openTrade).toHaveBeenCalled()
        expect(ctx.hyperliquid!.openPosition).toHaveBeenCalled()
      })

      it('tick() calls propose then execute (backward compat)', async () => {
        freezeMidHour()
        ;(ctx.twilight.fundingRate as any).mockResolvedValue(0.068)
        ;(ctx.hyperliquid!.getFundingRate as any).mockResolvedValue(0.0)

        await strategy.tick()

        expect(ctx.twilight.openTrade).toHaveBeenCalled()
        expect(ctx.hyperliquid!.openPosition).toHaveBeenCalled()
      })
    })
  })

  describe('computeRoundTripPnl', () => {
    it('SHORT-twilight gain in inverse-perp terms when exit < entry', () => {
      const r = computeRoundTripPnl({
        twilightEntry: 80_000, twilightExit: 70_000,
        twilightSide: 'SHORT', twilightSizeSats: 13_000,
        hyperliquidEntry: 80_000, hyperliquidExit: 70_000,
        hyperliquidSide: 'LONG', hyperliquidSize: 0.00013,
        fundingReceivedSats: 0, hyperliquidFundingUsdc: 0, closeMarkPrice: 70_000,
      })
      // SHORT inverse: 13000 * (80000/70000 - 1) ≈ 13000 * 0.1428 ≈ 1857 sats
      expect(r.twilightPnlSats).toBeGreaterThan(1800)
      expect(r.twilightPnlSats).toBeLessThan(1900)
      // Hyperliquid LONG loses USDC on price drop: 0.00013 * (70000-80000) = -1.3 USDC
      // In sats at 70k: -1.3/70000 * 1e8 ≈ -1857 sats
      expect(r.hyperliquidPnlSats).toBeLessThan(-1800)
      expect(r.hyperliquidPnlSats).toBeGreaterThan(-1900)
      // Net should be tiny (delta-neutral approximation; inverse vs linear breaks slightly with price)
      expect(Math.abs(r.totalSats)).toBeLessThan(100)
    })

    it('adds funding payments to total', () => {
      const r = computeRoundTripPnl({
        twilightEntry: 77_000, twilightExit: 77_000,
        twilightSide: 'SHORT', twilightSizeSats: 13_000,
        hyperliquidEntry: 77_000, hyperliquidExit: 77_000,
        hyperliquidSide: 'LONG', hyperliquidSize: 0.00013,
        fundingReceivedSats: 800, hyperliquidFundingUsdc: -0.001, closeMarkPrice: 77_000,
      })
      // Twilight + HL price PnL both zero, funding dominates
      expect(r.twilightPnlSats).toBe(0)
      expect(r.hyperliquidPnlSats).toBe(0)
      // 800 sats Twilight funding + small HL funding (~ -1 sat)
      expect(r.fundingPnlSats).toBeGreaterThan(795)
      expect(r.fundingPnlSats).toBeLessThanOrEqual(800)
      expect(r.totalSats).toBe(r.fundingPnlSats)
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

    describe('propose/execute split', () => {
      it('implements ProposableStrategy interface', () => {
        const proposable = strategy as unknown as ProposableStrategy
        expect(typeof proposable.propose).toBe('function')
        expect(typeof proposable.execute).toBe('function')
      })

      it('propose returns TradeProposal when APY above minimum', async () => {
        ;(ctx.twilight.lastDayApy as any).mockResolvedValue(18.0)

        const proposable = strategy as unknown as Strategy & ProposableStrategy
        const proposal = await proposable.propose(ctx)

        expect(proposal).not.toBeNull()
        expect(proposal!.action).toBe('open')
        expect(proposal!.strategyId).toBe('lending-yield')
      })

      it('propose returns null when APY below minimum and no positions', async () => {
        ;(ctx.twilight.lastDayApy as any).mockResolvedValue(5.0)
        ;(ctx.db.listPositions as any).mockReturnValue([])

        const proposable = strategy as unknown as Strategy & ProposableStrategy
        const proposal = await proposable.propose(ctx)

        expect(proposal).toBeNull()
      })

      it('execute opens lend positions with approve evaluation', async () => {
        ;(ctx.twilight.lastDayApy as any).mockResolvedValue(18.0)
        ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
          { index: 0, balance: 50000, onChain: true, ioType: 'Coin' },
        ])

        const evaluation: AgentEvaluation = { verdict: 'approve', confidence: 0.9, reasoning: 'test' }
        const proposable = strategy as unknown as Strategy & ProposableStrategy
        await proposable.execute(ctx, evaluation)

        expect(ctx.twilight.openLend).toHaveBeenCalled()
      })
    })
  })
})
