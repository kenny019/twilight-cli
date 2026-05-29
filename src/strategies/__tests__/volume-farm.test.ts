import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VolumeFarmStrategy } from '../templates/volume-farm.js'
import type { Context, TwilightClient, BinanceClient, HyperliquidClient, RiskManager, AlertClient, Logger, Database } from '../../types/index.js'

function makeCtx(): Context {
  return {
    twilight: {
      walletBalance: vi.fn().mockResolvedValue({ nyks: 1000, sats: 100000 }),
      walletAccounts: vi.fn().mockResolvedValue([{ index: 7, balance: 13000, onChain: true, ioType: 'Coin' }]),
      openTrade: vi.fn().mockResolvedValue({ requestId: 'TW1', accountIndex: 7, status: 'FILLED' }),
      closeTrade: vi.fn().mockResolvedValue({ requestId: 'TW2', accountIndex: 7, status: 'SETTLED' }),
      unlockTrade: vi.fn().mockResolvedValue({ requestId: 'TW3', accountIndex: 7, status: 'success' }),
      transfer: vi.fn().mockResolvedValue({ requestId: 'TW4', accountIndex: 8, status: 'success' }),
      waitForOrderStatus: vi.fn().mockResolvedValue('SETTLED'),
      marketPrice: vi.fn().mockResolvedValue(76700),
      fund: vi.fn(), withdraw: vi.fn(), split: vi.fn(),
      cancelTrade: vi.fn(), queryTrade: vi.fn().mockResolvedValue({ orderStatus: 'FILLED', raw: {} }),
      openLend: vi.fn(), closeLend: vi.fn(), queryLend: vi.fn(),
      fundingRate: vi.fn().mockResolvedValue(-0.002348),
      feeRate: vi.fn(), marketStats: vi.fn(), lendPool: vi.fn(),
      lastDayApy: vi.fn(), orderbook: vi.fn(),
    } as unknown as TwilightClient,
    binance: {} as BinanceClient,
    hyperliquid: {
      getMarkPrice: vi.fn().mockResolvedValue(76700),
      getFundingRate: vi.fn().mockResolvedValue(-0.0000165),
      openPosition: vi.fn().mockResolvedValue({ orderId: 1, status: 'filled', fillPrice: 76710, size: 0.0001, fee: 0, raw: {} }),
      closePosition: vi.fn().mockResolvedValue({ orderId: 2, status: 'filled', fillPrice: 76705, size: 0.0001, fee: 0, raw: {} }),
      getPosition: vi.fn().mockResolvedValue(null),
      getBalance: vi.fn().mockResolvedValue(58.5),
      getRealizedFunding: vi.fn().mockResolvedValue([]),
      quantizeBtcSize: vi.fn((sats: number, mark: number) => {
        const step = 0.00001
        return Math.max(Math.ceil((sats / 1e8) / step) * step, Math.ceil((10 / mark) / step) * step)
      }),
    } as unknown as HyperliquidClient,
    risk: {
      checkPreTrade: vi.fn().mockResolvedValue({ allowed: true }),
      checkDrawdown: vi.fn().mockResolvedValue({ allowed: true }),
      checkDailyLoss: vi.fn().mockResolvedValue({ allowed: true }),
      checkCooldown: vi.fn().mockResolvedValue({ allowed: true }),
      isKillSwitchActive: vi.fn().mockResolvedValue(false),
      activateKillSwitch: vi.fn(), deactivateKillSwitch: vi.fn(),
      recordTrade: vi.fn(),
      checkConnectionHealth: vi.fn().mockResolvedValue({ allowed: true }),
      reportConnectionStatus: vi.fn(),
    } as RiskManager,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as Logger,
    db: {} as Database,
    alert: { send: vi.fn(), sendTradeAlert: vi.fn(), sendErrorAlert: vi.fn(), sendRiskAlert: vi.fn() } as unknown as AlertClient,
  }
}

describe('VolumeFarmStrategy', () => {
  let strategy: VolumeFarmStrategy
  let ctx: Context

  beforeEach(async () => {
    ctx = makeCtx()
    strategy = new VolumeFarmStrategy()
    await strategy.init({
      positionSizeSats: 5_000,
      checkIntervalMs: 30_000,
      dedicatedAccountIndices: [],
      hyperliquidLeverage: 1,
      hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 50_000_000,
      maxConsecutiveFailures: 3,
      sideRotation: 'alternate',
    }, ctx)
  })

  it('happy path: HL open → Twilight open → HL close → Twilight close → unlock → transfer; daily volume increments', async () => {
    await strategy.tick()

    expect(ctx.hyperliquid!.openPosition).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)
    expect(ctx.hyperliquid!.closePosition).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.closeTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.unlockTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.transfer).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.transfer).toHaveBeenCalledWith(7)

    // 2× positionSizeSats (open + close legs)
    const status = strategy.status()
    expect((status.config as any).dailyVolumeSats).toBe(10_000)
    expect((status.config as any).totalVolume).toBe(10_000)
  })

  it('transfer failure after close: counts as failure (account state needs manual cleanup)', async () => {
    ;(ctx.twilight.transfer as any).mockRejectedValue(new Error('transfer-rejected'))
    await strategy.tick()
    // open/close path ran fully
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.closeTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.unlockTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.transfer).toHaveBeenCalledTimes(1)
    // recordFailure bumps both counters by exactly one
    expect((strategy as any).consecutiveFailures).toBe(1)
    expect(strategy.status().errorCount).toBe(1)
  })

  it('daily volume cap halts further opens', async () => {
    await strategy.init({
      positionSizeSats: 5_000,
      checkIntervalMs: 30_000,
      dedicatedAccountIndices: [],
      hyperliquidLeverage: 1,
      hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 10_000,   // cap = exactly one round
      maxConsecutiveFailures: 3,
      sideRotation: 'alternate',
    }, ctx)

    await strategy.tick()  // round 1 — adds 10_000, hits cap
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)

    await strategy.tick()  // round 2 — should be skipped (cap reached)
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)
  })

  it('alternate side rotation: LONG then SHORT then LONG ...', async () => {
    await strategy.tick()
    await strategy.tick()
    await strategy.tick()

    const sides = (ctx.twilight.openTrade as any).mock.calls.map((c: any[]) => c[1])
    expect(sides).toEqual(['LONG', 'SHORT', 'LONG'])
  })

  it('long-only rotation always opens LONG on Twilight (SHORT on HL)', async () => {
    await strategy.init({
      positionSizeSats: 5_000, checkIntervalMs: 30_000, dedicatedAccountIndices: [],
      hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 1_000_000_000, maxConsecutiveFailures: 3,
      sideRotation: 'long-only',
    }, ctx)
    await strategy.tick()
    await strategy.tick()
    const twSides = (ctx.twilight.openTrade as any).mock.calls.map((c: any[]) => c[1])
    const hlSides = (ctx.hyperliquid!.openPosition as any).mock.calls.map((c: any[]) => c[0])
    expect(twSides).toEqual(['LONG', 'LONG'])
    expect(hlSides).toEqual(['SHORT', 'SHORT'])
  })

  it('respects risk killswitch — no opens', async () => {
    ;(ctx.risk.isKillSwitchActive as any).mockResolvedValue(true)
    await strategy.tick()
    expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    expect(ctx.hyperliquid!.openPosition).not.toHaveBeenCalled()
  })

  it('skips if no eligible Coin account exists and replenish fails', async () => {
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
      { index: 7, balance: 13000, onChain: false, ioType: 'Coin' },    // off-chain
      { index: 8, balance: 13000, onChain: true,  ioType: 'Memo' },    // wrong type
      { index: 9, balance: 1000,  onChain: true,  ioType: 'Coin' },    // too small
    ])
    ;(ctx.twilight.walletBalance as any).mockResolvedValue({ nyks: 1000, sats: 0 })
    await strategy.tick()
    expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
  })

  it('auto-replenishes when pool is dry, then completes the round', async () => {
    let call = 0
    const dry = [{ index: 9, balance: 1000, onChain: true, ioType: 'Coin', txType: '-' }]
    const filled = [{ index: 30, balance: 13000, onChain: true, ioType: 'Coin', txType: '-' }]
    ;(ctx.twilight.walletAccounts as any).mockImplementation(() => {
      call++
      return Promise.resolve(call <= 1 ? dry : filled)
    })
    ;(ctx.twilight.walletBalance as any).mockResolvedValue({ nyks: 1000, sats: 200_000 })
    ;(ctx.twilight.fund as any).mockResolvedValue({ requestId: 'F1', accountIndex: 20, status: 'success' })
    ;(ctx.twilight.split as any).mockResolvedValue({ requestId: 'S1', accountIndex: 0, status: 'success' })

    ;(strategy as any).replenishPollIntervalMs = 1
    ;(strategy as any).replenishPollTimeoutMs = 50
    ;(strategy as any).replenishInterSplitMs = 0

    await strategy.tick()

    expect(ctx.twilight.fund).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.split).toHaveBeenCalled()
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.openTrade).toHaveBeenCalledWith(30, expect.any(String), expect.any(Number), 1)
  })

  it('trips killswitch after maxConsecutiveFailures when wallet has no sats', async () => {
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue([])
    ;(ctx.twilight.walletBalance as any).mockResolvedValue({ nyks: 1000, sats: 0 })
    ;(strategy as any).replenishCooldownMs = 0

    await strategy.tick()
    await strategy.tick()
    await strategy.tick()
    expect(strategy.status().status).toBe('stopped')
  })

  it('cooldown prevents re-replenish on subsequent ticks (no killswitch trip)', async () => {
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue([])
    ;(ctx.twilight.walletBalance as any).mockResolvedValue({ nyks: 1000, sats: 200_000 })
    ;(ctx.twilight.fund as any).mockResolvedValue({ requestId: 'F1', accountIndex: 20, status: 'success' })
    ;(ctx.twilight.split as any).mockResolvedValue({ requestId: 'S1', accountIndex: 0, status: 'success' })
    ;(strategy as any).replenishPollIntervalMs = 1
    ;(strategy as any).replenishPollTimeoutMs = 5
    ;(strategy as any).replenishCooldownMs = 1_000_000
    ;(strategy as any).replenishInterSplitMs = 0

    await strategy.tick()
    await strategy.tick()
    await strategy.tick()

    expect(ctx.twilight.fund).toHaveBeenCalledTimes(1)
    expect(strategy.status().status).toBe('active')
  })

  it('skips if HL balance below requiredMargin + buffer', async () => {
    ;(ctx.hyperliquid!.getBalance as any).mockResolvedValue(3)   // less than $10 min + $5 buffer
    await strategy.tick()
    expect(ctx.hyperliquid!.openPosition).not.toHaveBeenCalled()
    expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
  })

  it('HL open failure: no Twilight open, no naked legs', async () => {
    ;(ctx.hyperliquid!.openPosition as any).mockRejectedValue(new Error('hl-network'))
    await strategy.tick()
    expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
    expect(ctx.hyperliquid!.closePosition).not.toHaveBeenCalled()
  })

  it('Twilight open failure: compensating HL close fires', async () => {
    ;(ctx.twilight.openTrade as any).mockRejectedValue(new Error('tw-rejected'))
    await strategy.tick()
    expect(ctx.hyperliquid!.openPosition).toHaveBeenCalledTimes(1)
    expect(ctx.hyperliquid!.closePosition).toHaveBeenCalledTimes(1)   // compensating
    expect(ctx.twilight.closeTrade).not.toHaveBeenCalled()
  })

  it('trips per-strategy disable after maxConsecutiveFailures', async () => {
    ;(ctx.hyperliquid!.openPosition as any).mockRejectedValue(new Error('persistent-fail'))
    await strategy.tick()
    await strategy.tick()
    await strategy.tick()
    expect(strategy.status().status).toBe('stopped')
    // killswitch trip must fire an alert — the only operator-visible signal
    expect(ctx.alert.send).toHaveBeenCalledTimes(1)
    expect((ctx.alert.send as any).mock.calls[0][0]).toMatchObject({ type: 'error' })
    // Subsequent ticks short-circuit
    ;(ctx.hyperliquid!.openPosition as any).mockResolvedValue({ status: 'filled', size: 0.0001, raw: {} })
    await strategy.tick()
    // openTrade should still not be called (strategy is disabled)
    expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
  })

  it('tracks per-round cost: fee estimate + mark-to-mark drift in status', async () => {
    // marketPrice mock returns a constant, so mark drift is 0 and only the
    // fee estimate accrues: 2 legs × 5000 sats × 0.0004 = 4 sats.
    await strategy.tick()
    const cfg = strategy.status().config as any
    expect(cfg.totalFeesSats).toBe(4)
    expect(cfg.totalMarkPnlSats).toBe(0)
    expect(cfg.netCostSats).toBe(4)
  })

  it('mark-to-mark drift is signed by side (LONG gains when mark rises)', async () => {
    // entry mark 76700 (open) then exit mark 77467 (~+1%) → LONG nets +~50 sats
    ;(ctx.twilight.marketPrice as any)
      .mockResolvedValueOnce(76700)   // open (LONG in alternate mode)
      .mockResolvedValueOnce(77467)   // close
    await strategy.tick()
    const cfg = strategy.status().config as any
    expect(cfg.totalMarkPnlSats).toBeGreaterThan(0)
  })

  it('persists volume state and restores it on a fresh init (cap survives restart)', async () => {
    const store = new Map<string, string>()
    ;(ctx as any).db = {
      getKV: (k: string) => store.get(k),
      setKV: (k: string, v: string) => { store.set(k, v) },
    }
    const cfg = {
      positionSizeSats: 5_000, checkIntervalMs: 30_000, dedicatedAccountIndices: [],
      hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 50_000_000, maxConsecutiveFailures: 3, sideRotation: 'alternate' as const,
    }
    const s1 = new VolumeFarmStrategy()
    await s1.init(cfg, ctx)
    await s1.tick()   // one round → 10_000 sats, persisted to kv
    expect(store.has('volume-farm:volume')).toBe(true)

    // simulate restart: new instance, same kv-backed ctx
    const s2 = new VolumeFarmStrategy()
    await s2.init(cfg, ctx)
    const restored = s2.status().config as any
    expect(restored.dailyVolumeSats).toBe(10_000)
    expect(restored.totalVolume).toBe(10_000)
  })

  it('reconcileStuck closes an orphaned OPEN position and alerts', async () => {
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
      { index: 5, balance: 5000, onChain: true, ioType: 'Memo', txType: 'ORDERTX' },
    ])
    ;(ctx.twilight.queryTrade as any).mockResolvedValue({ orderStatus: 'FILLED', raw: {} })
    const res = await strategy.reconcileStuck(ctx)
    expect(ctx.twilight.closeTrade).toHaveBeenCalledWith(5, { skipRotation: true })
    expect(ctx.twilight.unlockTrade).toHaveBeenCalledWith(5)
    expect(ctx.twilight.transfer).toHaveBeenCalledWith(5)
    expect(res).toMatchObject({ reclaimed: 1, orphans: 1 })
    expect(ctx.alert.send).toHaveBeenCalledTimes(1)
    expect((ctx.alert.send as any).mock.calls[0][0]).toMatchObject({ type: 'risk' })
  })

  it('reconcileStuck unlocks + rotates a SETTLED Memo account without closing or alerting', async () => {
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
      { index: 6, balance: 4996, onChain: true, ioType: 'Memo', txType: 'ORDERTX' },
    ])
    ;(ctx.twilight.queryTrade as any).mockResolvedValue({ orderStatus: 'SETTLED', raw: {} })
    const res = await strategy.reconcileStuck(ctx)
    expect(ctx.twilight.closeTrade).not.toHaveBeenCalled()
    expect(ctx.twilight.unlockTrade).toHaveBeenCalledWith(6)
    expect(ctx.twilight.transfer).toHaveBeenCalledWith(6)
    expect(res).toMatchObject({ reclaimed: 1, orphans: 0 })
    expect(ctx.alert.send).not.toHaveBeenCalled()
  })

  it('reconcileStuck ignores empty Coin/ORDERTX husks, rotates only funded ones', async () => {
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue([
      { index: 10, balance: 0,    onChain: true, ioType: 'Coin', txType: 'ORDERTX' },  // empty husk
      { index: 11, balance: 8000, onChain: true, ioType: 'Coin', txType: 'ORDERTX' },  // funded
      { index: 12, balance: 9000, onChain: true, ioType: 'Coin', txType: '-' },        // fresh, not stuck
    ])
    const res = await strategy.reconcileStuck(ctx)
    expect(ctx.twilight.transfer).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.transfer).toHaveBeenCalledWith(11)
    expect(res).toMatchObject({ reclaimed: 1, orphans: 0 })
  })

  it('boot reconcile is bounded by maxReclaimPerBoot', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      index: 100 + i, balance: 8000, onChain: true, ioType: 'Coin', txType: 'ORDERTX',
    }))
    ;(ctx.twilight.walletAccounts as any).mockResolvedValue(many)
    ;(strategy as any).maxReclaimPerBoot = 25
    const res = await strategy.reconcileStuck(ctx)
    expect(ctx.twilight.transfer).toHaveBeenCalledTimes(25)
    expect(res).toMatchObject({ reclaimed: 25, remaining: 5 })
  })

  it('tick reclaims a stuck account when pool is dry, then completes the round', async () => {
    let call = 0
    const stuckOnly = [{ index: 6, balance: 4996, onChain: true, ioType: 'Memo', txType: 'ORDERTX' }]
    const fresh = [{ index: 40, balance: 13000, onChain: true, ioType: 'Coin', txType: '-' }]
    ;(ctx.twilight.walletAccounts as any).mockImplementation(() => {
      call++
      return Promise.resolve(call <= 1 ? stuckOnly : fresh)
    })
    ;(ctx.twilight.queryTrade as any).mockResolvedValue({ orderStatus: 'SETTLED', raw: {} })
    await strategy.tick()
    expect(ctx.twilight.unlockTrade).toHaveBeenCalledWith(6)         // reclaimed the stuck one
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.openTrade).toHaveBeenCalledWith(40, expect.any(String), expect.any(Number), 1)
    expect(ctx.twilight.fund).not.toHaveBeenCalled()                 // reclaim preempted replenish
  })

  it('inert when hyperliquid client not configured', async () => {
    const noHlCtx = makeCtx()
    delete (noHlCtx as any).hyperliquid
    await strategy.init({
      positionSizeSats: 5_000, checkIntervalMs: 30_000, dedicatedAccountIndices: [],
      hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 50_000_000, maxConsecutiveFailures: 3,
      sideRotation: 'alternate',
    }, noHlCtx)
    await strategy.tick()
    expect(noHlCtx.twilight.openTrade).not.toHaveBeenCalled()
  })

  it("hedge='none' mode: skips HL entirely, completes round on Twilight alone", async () => {
    await strategy.init({
      positionSizeSats: 3_000, checkIntervalMs: 60_000, dedicatedAccountIndices: [],
      hedge: 'none',
      hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 50_000_000, maxConsecutiveFailures: 3,
      sideRotation: 'alternate',
    }, ctx)

    await strategy.tick()

    // HL NEVER called
    expect(ctx.hyperliquid!.openPosition).not.toHaveBeenCalled()
    expect(ctx.hyperliquid!.closePosition).not.toHaveBeenCalled()
    expect(ctx.hyperliquid!.getBalance).not.toHaveBeenCalled()
    expect(ctx.hyperliquid!.getMarkPrice).not.toHaveBeenCalled()

    // Twilight full cycle
    expect(ctx.twilight.openTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.closeTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.unlockTrade).toHaveBeenCalledTimes(1)
    expect(ctx.twilight.transfer).toHaveBeenCalledTimes(1)
  })

  it("hedge='none' + no HL configured: still works", async () => {
    const noHlCtx = makeCtx()
    delete (noHlCtx as any).hyperliquid
    await strategy.init({
      positionSizeSats: 3_000, checkIntervalMs: 60_000, dedicatedAccountIndices: [],
      hedge: 'none',
      hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 50_000_000, maxConsecutiveFailures: 3,
      sideRotation: 'alternate',
    }, noHlCtx)

    await strategy.tick()
    expect(noHlCtx.twilight.openTrade).toHaveBeenCalledTimes(1)
    expect(noHlCtx.twilight.closeTrade).toHaveBeenCalledTimes(1)
  })

  it('dedicatedAccountIndices filter respected when non-empty', async () => {
    await strategy.init({
      positionSizeSats: 5_000, checkIntervalMs: 30_000,
      dedicatedAccountIndices: [99],     // index 99 doesn't exist in mock
      hyperliquidLeverage: 1, hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats: 50_000_000, maxConsecutiveFailures: 3,
      sideRotation: 'alternate',
    }, ctx)
    await strategy.tick()
    expect(ctx.twilight.openTrade).not.toHaveBeenCalled()
  })
})
