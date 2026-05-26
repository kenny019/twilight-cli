import type {
  Strategy,
  StrategyConfig,
  StrategyInfo,
  Context,
  OrderSide,
} from '../../types/index.js'
import type { ProposableStrategy, TradeProposal, AgentEvaluation } from '../../types/agent.js'
import { DEFAULT_EVALUATION } from '../../types/agent.js'

interface FundingArbConfig {
  entryThreshold: number               // absolute |twilight - hedge| per-hour
  exitThreshold: number                // absolute |twilight - hedge| per-hour
  positionSizeSats: number             // size of Twilight leg
  checkIntervalMs: number              // tick interval
  dedicatedAccountIndices: number[]    // only these Twilight account indices are used
  maxConsecutiveFailures: number       // per-strategy killswitch trip threshold
  minHoldUntilNextFundingMs: number    // skip new opens this close to the next payment
  maxHoldMs: number                    // hard cap on any single position
  hyperliquidLeverage: number          // leverage to request on Hyperliquid
  hyperliquidMarginBufferUsdc: number  // require balance >= margin + buffer
}

interface ActivePosition {
  positionDbId: string
  twilightAccountIndex: number
  twilightSide: OrderSide
  twilightEntryPrice: number
  twilightSizeSats: number
  hyperliquidSide: OrderSide
  hyperliquidEntryPrice: number
  hyperliquidSize: number              // BTC
  openedAt: number                     // ms epoch
}

const FUNDING_PERIOD_MS = 3_600_000

export interface RoundTripPnlInput {
  twilightEntry: number
  twilightExit: number
  twilightSide: OrderSide
  twilightSizeSats: number
  hyperliquidEntry: number
  hyperliquidExit: number
  hyperliquidSide: OrderSide
  hyperliquidSize: number             // BTC
  fundingReceivedSats: number         // sats accrued on the Twilight short/long leg
  hyperliquidFundingUsdc: number      // signed USDC delta from Hyperliquid userFunding
  closeMarkPrice: number              // BTC/USD used to convert HL USDC to sats
}

export interface RoundTripPnl {
  twilightPnlSats: number
  hyperliquidPnlSats: number
  fundingPnlSats: number
  totalSats: number
}

/**
 * Compute round-trip PnL for a delta-neutral pair.
 * Twilight is an inverse perp denominated in sats. Hyperliquid is a linear USDC perp.
 */
export function computeRoundTripPnl(i: RoundTripPnlInput): RoundTripPnl {
  // Inverse perp PnL in sats:
  //   LONG:  size_sats * (1 - entry/exit)
  //   SHORT: size_sats * (entry/exit - 1)
  const twRatio = i.twilightSide === 'LONG'
    ? (1 - i.twilightEntry / i.twilightExit)
    : (i.twilightEntry / i.twilightExit - 1)
  const twilightPnlSats = Math.round(i.twilightSizeSats * twRatio)

  // Linear perp PnL in USDC:
  //   LONG:  size_btc * (exit - entry)
  //   SHORT: size_btc * (entry - exit)
  const hlPnlUsdc = i.hyperliquidSide === 'LONG'
    ? i.hyperliquidSize * (i.hyperliquidExit - i.hyperliquidEntry)
    : i.hyperliquidSize * (i.hyperliquidEntry - i.hyperliquidExit)
  const hyperliquidPnlSats = Math.round((hlPnlUsdc / i.closeMarkPrice) * 1e8)

  const hlFundingSats = Math.round((i.hyperliquidFundingUsdc / i.closeMarkPrice) * 1e8)
  const fundingPnlSats = i.fundingReceivedSats + hlFundingSats

  return {
    twilightPnlSats,
    hyperliquidPnlSats,
    fundingPnlSats,
    totalSats: twilightPnlSats + hyperliquidPnlSats + fundingPnlSats,
  }
}

export class FundingArbStrategy implements Strategy, ProposableStrategy {
  id = 'funding-arb'
  name = 'Funding Rate Arbitrage'
  description = 'Delta-neutral funding-rate arbitrage between Twilight and Hyperliquid'

  configSchema = {
    type: 'object',
    properties: {
      entryThreshold:               { type: 'number' },
      exitThreshold:                { type: 'number' },
      positionSizeSats:             { type: 'number' },
      checkIntervalMs:              { type: 'number' },
      dedicatedAccountIndices:      { type: 'array', items: { type: 'number' } },
      maxConsecutiveFailures:       { type: 'number' },
      minHoldUntilNextFundingMs:    { type: 'number' },
      maxHoldMs:                    { type: 'number' },
      hyperliquidLeverage:          { type: 'number' },
      hyperliquidMarginBufferUsdc:  { type: 'number' },
    },
    required: ['entryThreshold', 'exitThreshold', 'positionSizeSats', 'checkIntervalMs', 'dedicatedAccountIndices'],
  }

  config!: FundingArbConfig
  private ctx!: Context
  private tickCount = 0
  private errorCount = 0
  private lastTick: string | null = null
  private running = true

  private position: ActivePosition | null = null
  private consecutiveFailures = 0
  private disabled = false
  private tickInFlight: Promise<void> | null = null

  async init(config: StrategyConfig, ctx: Context): Promise<void> {
    this.config = {
      entryThreshold: 0.01,
      exitThreshold: 0.002,
      positionSizeSats: 13_000,
      checkIntervalMs: 300_000,
      dedicatedAccountIndices: [2, 3],
      maxConsecutiveFailures: 3,
      minHoldUntilNextFundingMs: 600_000,
      maxHoldMs: 24 * FUNDING_PERIOD_MS,
      hyperliquidLeverage: 1,
      hyperliquidMarginBufferUsdc: 5,
      ...(config as unknown as Partial<FundingArbConfig>),
    }
    this.ctx = ctx
    this.rehydratePositionFromDb()
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = this.runTick().finally(() => { this.tickInFlight = null })
    return this.tickInFlight
  }

  private async runTick(): Promise<void> {
    try {
      const proposal = await this.propose(this.ctx)
      if (!proposal) return
      await this.execute(this.ctx, DEFAULT_EVALUATION)
    } finally {
      this.tickCount++
      this.lastTick = new Date().toISOString()
    }
  }

  async propose(ctx: Context): Promise<TradeProposal | null> {
    if (this.disabled) return null
    if (await ctx.risk.isKillSwitchActive()) return null
    if (!ctx.hyperliquid) {
      ctx.log.debug('funding-arb: hyperliquid client not configured — inert')
      return null
    }

    let twilightRate: number
    let hyperliquidRate: number
    let twilightMark: number
    try {
      [twilightRate, hyperliquidRate, twilightMark] = await Promise.all([
        ctx.twilight.fundingRate(),
        ctx.hyperliquid.getFundingRate(),
        ctx.twilight.marketPrice(),
      ])
    } catch (err) {
      this.errorCount++
      ctx.log.error('funding-arb propose: rate read failed', { error: (err as Error).message })
      return null
    }

    const signedDiff = twilightRate - hyperliquidRate
    const absDiff = Math.abs(signedDiff)
    const snapshot = {
      price: twilightMark,
      twilightFundingRate: twilightRate,
      binanceFundingRate: hyperliquidRate,    // legacy field reused for hedge venue
      hyperliquidFundingRate: hyperliquidRate,
      signedDifferential: signedDiff,
      differential: absDiff,
      timestamp: new Date().toISOString(),
    }

    if (!this.position) {
      if (absDiff < this.config.entryThreshold) return null
      const twilightSide: OrderSide = signedDiff > 0 ? 'SHORT' : 'LONG'
      return {
        strategyId: this.id,
        action: 'open',
        side: twilightSide,
        sizeSats: this.config.positionSizeSats,
        entryPrice: twilightMark,
        leverage: 1,
        reason: `signedDiff ${signedDiff.toFixed(6)} (twilight ${twilightRate.toFixed(6)} vs hl ${hyperliquidRate.toFixed(6)}) — open ${twilightSide} on Twilight`,
        marketSnapshot: snapshot,
      }
    }

    const ageMs = Date.now() - this.position.openedAt
    const overdue = ageMs >= this.config.maxHoldMs
    const signFlipped = Math.sign(signedDiff) !== signFromSide(this.position.twilightSide)
    if (absDiff < this.config.exitThreshold || overdue || signFlipped) {
      return {
        strategyId: this.id,
        action: 'close',
        reason: overdue
          ? `position held ${(ageMs / FUNDING_PERIOD_MS).toFixed(1)}h — max-hold exit`
          : signFlipped
            ? `signed differential flipped sign (${signedDiff.toFixed(6)}) — close to avoid paying funding`
            : `signedDiff ${signedDiff.toFixed(6)} below exit threshold ${this.config.exitThreshold}`,
        marketSnapshot: snapshot,
      }
    }
    return null
  }

  async execute(ctx: Context, _evaluation: AgentEvaluation): Promise<void> {
    if (this.disabled || !ctx.hyperliquid) return
    if (this.position) {
      await this.closeAtomic(ctx)
    } else {
      await this.openAtomic(ctx)
    }
  }

  private async openAtomic(ctx: Context): Promise<void> {
    const hl = ctx.hyperliquid!
    const cfg = this.config

    let twilightRate: number, hyperliquidRate: number, twilightMark: number, hlMark: number
    try {
      [twilightRate, hyperliquidRate, twilightMark, hlMark] = await Promise.all([
        ctx.twilight.fundingRate(),
        hl.getFundingRate(),
        ctx.twilight.marketPrice(),
        hl.getMarkPrice(),
      ])
    } catch (err) {
      ctx.log.error('funding-arb open: pre-trade read failed', { error: (err as Error).message })
      return
    }
    const signedDiff = twilightRate - hyperliquidRate
    if (Math.abs(signedDiff) < cfg.entryThreshold) {
      ctx.log.info('funding-arb open: differential collapsed between propose and execute — skip', { signedDiff })
      return
    }
    const twilightSide: OrderSide = signedDiff > 0 ? 'SHORT' : 'LONG'
    const hlSide: OrderSide = twilightSide === 'SHORT' ? 'LONG' : 'SHORT'

    // Payment-window guard
    const nextFundingMs = Math.ceil(Date.now() / FUNDING_PERIOD_MS) * FUNDING_PERIOD_MS
    if (Date.now() + cfg.minHoldUntilNextFundingMs > nextFundingMs) {
      ctx.log.info('funding-arb open: too close to next funding payment — skip', {
        msUntilFunding: nextFundingMs - Date.now(),
      })
      return
    }

    // Risk + balance checks
    const { sats: walletSats } = await ctx.twilight.walletBalance()
    const riskCheck = await ctx.risk.checkPreTrade(this.id, cfg.positionSizeSats, walletSats)
    if (!riskCheck.allowed) {
      ctx.log.warn('funding-arb open: risk check blocked', { control: riskCheck.control, reason: riskCheck.reason })
      await ctx.alert.sendRiskAlert(this.id, riskCheck)
      return
    }

    // Idle Twilight account from dedicated set (empty list = no index filter)
    const accounts = await ctx.twilight.walletAccounts()
    const indexFilter = cfg.dedicatedAccountIndices.length === 0
      ? () => true
      : (idx: number) => cfg.dedicatedAccountIndices.includes(idx)
    const idleAccount = accounts.find(a =>
      indexFilter(a.index)
      && a.onChain
      && a.ioType === 'Coin'
      && a.balance >= cfg.positionSizeSats,
    )
    if (!idleAccount) {
      ctx.log.warn('funding-arb open: no eligible dedicated account', {
        dedicated: cfg.dedicatedAccountIndices,
        positionSizeSats: cfg.positionSizeSats,
      })
      return
    }

    // Hyperliquid balance check
    const sizeBtc = hl.quantizeBtcSize(cfg.positionSizeSats, hlMark)
    const requiredMargin = (sizeBtc * hlMark) / cfg.hyperliquidLeverage
    const hlBalance = await hl.getBalance()
    if (hlBalance < requiredMargin + cfg.hyperliquidMarginBufferUsdc) {
      ctx.log.warn('funding-arb open: insufficient Hyperliquid USDC', {
        balance: hlBalance, required: requiredMargin + cfg.hyperliquidMarginBufferUsdc,
      })
      return
    }

    // Atomic open: Hyperliquid first (fast), Twilight second (may hang)
    let hlResult: Awaited<ReturnType<typeof hl.openPosition>>
    try {
      hlResult = await hl.openPosition(hlSide, sizeBtc, cfg.hyperliquidLeverage)
      if (hlResult.status !== 'filled') {
        ctx.log.warn('funding-arb open: hyperliquid did not fill — abort', { hlResult })
        return
      }
    } catch (err) {
      this.recordFailure(ctx, 'hyperliquid-open', err as Error)
      return
    }

    let twilightResult: Awaited<ReturnType<typeof ctx.twilight.openTrade>>
    try {
      twilightResult = await ctx.twilight.openTrade(idleAccount.index, twilightSide, twilightMark, 1)
    } catch (err) {
      ctx.log.error('funding-arb open: twilight failed — compensating hl close', { error: (err as Error).message })
      await this.compensatingHyperliquidClose(ctx, hlSide, hlResult.size)
      this.recordFailure(ctx, 'twilight-open', err as Error)
      return
    }

    // TOCTOU re-check
    try {
      const [twR2, hlR2] = await Promise.all([ctx.twilight.fundingRate(), hl.getFundingRate()])
      const signed2 = twR2 - hlR2
      if (Math.abs(signed2) < cfg.exitThreshold || Math.sign(signed2) !== Math.sign(signedDiff)) {
        ctx.log.warn('funding-arb open: TOCTOU re-check failed — immediate unwind', { signed2, signedDiff })
        await this.unwindBothLegs(ctx, idleAccount.index, hlSide, hlResult.size)
        return
      }
    } catch (err) {
      ctx.log.warn('funding-arb open: TOCTOU re-check rate read failed — proceeding', { error: (err as Error).message })
    }

    // Persist
    const positionDbId = ctx.db.createPosition({
      strategyId: this.id,
      exchange: 'twilight',
      side: twilightSide,
      entryPrice: twilightMark,
      size: cfg.positionSizeSats,
      leverage: 1,
      status: 'open',
    }).id
    ctx.db.createTrade({ positionId: positionDbId, type: 'open', price: twilightMark, size: cfg.positionSizeSats, fee: 0, pnl: 0 })
    ctx.db.createAccount({ exchange: 'twilight', accountIndex: idleAccount.index, status: 'active', balance: cfg.positionSizeSats })

    this.position = {
      positionDbId,
      twilightAccountIndex: idleAccount.index,
      twilightSide,
      twilightEntryPrice: twilightMark,
      twilightSizeSats: cfg.positionSizeSats,
      hyperliquidSide: hlSide,
      hyperliquidEntryPrice: hlResult.fillPrice,
      hyperliquidSize: hlResult.size,
      openedAt: Date.now(),
    }
    this.consecutiveFailures = 0

    await ctx.alert.sendTradeAlert(this.id, 'open', {
      twilightSide, twilightAccountIndex: idleAccount.index,
      hlSide, hlSize: hlResult.size, hlEntry: hlResult.fillPrice,
      signedDiff, twilightRequestId: twilightResult.requestId,
    })
    ctx.log.info('funding-arb opened delta-neutral position', { signedDiff, twilightSide, hlSize: hlResult.size })
  }

  private async closeAtomic(ctx: Context): Promise<void> {
    const hl = ctx.hyperliquid!
    if (!this.position) return
    const pos = this.position

    let hlCloseRes: Awaited<ReturnType<typeof hl.closePosition>> | null = null
    try {
      hlCloseRes = await hl.closePosition(pos.hyperliquidSide, pos.hyperliquidSize)
      if (hlCloseRes.status !== 'filled') {
        ctx.log.warn('funding-arb close: hyperliquid did not fill — abort close', { hlCloseRes })
        return
      }
    } catch (err) {
      this.recordFailure(ctx, 'hyperliquid-close', err as Error)
      return
    }

    let twilightCloseRes: Awaited<ReturnType<typeof ctx.twilight.closeTrade>>
    try {
      twilightCloseRes = await ctx.twilight.closeTrade(pos.twilightAccountIndex)
    } catch (err) {
      ctx.log.error('funding-arb close: twilight close failed — re-hedging on hyperliquid', {
        error: (err as Error).message, accountIndex: pos.twilightAccountIndex,
      })
      try {
        await hl.openPosition(pos.hyperliquidSide, pos.hyperliquidSize, this.config.hyperliquidLeverage)
        ctx.db.updatePosition(pos.positionDbId, { status: 'open' })  // stays open in DB
        await ctx.alert.send({
          type: 'error',
          title: 'funding-arb: Twilight close stuck — re-hedged',
          description: `Account ${pos.twilightAccountIndex} unresponsive; restored hl hedge. Operator action required.`,
        })
      } catch (rehedgeErr) {
        ctx.log.error('funding-arb close: re-hedge also failed — naked twilight leg', { error: (rehedgeErr as Error).message })
        await ctx.alert.send({
          type: 'error',
          title: 'funding-arb: CRITICAL — naked Twilight leg',
          description: `Both Twilight close and HL re-hedge failed for account ${pos.twilightAccountIndex}.`,
        })
      }
      this.recordFailure(ctx, 'twilight-close', err as Error)
      return
    }

    // PnL — best-effort. Funding numbers default to 0 if unavailable.
    const closeMark = await ctx.twilight.marketPrice().catch(() => pos.twilightEntryPrice)
    let hlFundingUsdc = 0
    try {
      const fundingEntries = await hl.getRealizedFunding(pos.openedAt)
      hlFundingUsdc = fundingEntries.reduce((acc, e) => acc + e.usdc, 0)
    } catch (err) {
      ctx.log.warn('funding-arb close: hl funding history read failed', { error: (err as Error).message })
    }

    const pnl = computeRoundTripPnl({
      twilightEntry: pos.twilightEntryPrice,
      twilightExit: closeMark,
      twilightSide: pos.twilightSide,
      twilightSizeSats: pos.twilightSizeSats,
      hyperliquidEntry: pos.hyperliquidEntryPrice,
      hyperliquidExit: hlCloseRes.fillPrice,
      hyperliquidSide: pos.hyperliquidSide,
      hyperliquidSize: pos.hyperliquidSize,
      fundingReceivedSats: 0,
      hyperliquidFundingUsdc: hlFundingUsdc,
      closeMarkPrice: closeMark,
    })

    ctx.db.createTrade({
      positionId: pos.positionDbId, type: 'close',
      price: closeMark, size: pos.twilightSizeSats, fee: 0, pnl: pnl.totalSats,
    })
    ctx.db.updatePosition(pos.positionDbId, { status: 'closed', closedAt: new Date().toISOString() })

    const acctRec = ctx.db.getAccount('twilight', pos.twilightAccountIndex)
    if (acctRec) ctx.db.updateAccount(acctRec.id, { status: 'idle' })

    await ctx.risk.recordTrade(this.id, pnl.totalSats)
    await ctx.alert.sendTradeAlert(this.id, 'close', {
      twilightAccountIndex: pos.twilightAccountIndex,
      pnlSats: pnl.totalSats,
      breakdown: pnl,
      twilightRequestId: twilightCloseRes.requestId,
    })
    ctx.journal?.recordOutcome({
      type: 'outcome',
      timestamp: new Date().toISOString(),
      strategyId: this.id,
      evaluationTimestamp: new Date(pos.openedAt).toISOString(),
      pnl: pnl.totalSats,
      holdDurationMs: Date.now() - pos.openedAt,
      exitReason: 'differential collapsed or sign flipped',
      metrics: {
        twilightPnlSats: pnl.twilightPnlSats,
        hyperliquidPnlSats: pnl.hyperliquidPnlSats,
        fundingPnlSats: pnl.fundingPnlSats,
      },
    })

    ctx.log.info('funding-arb closed', { pnlSats: pnl.totalSats })
    this.position = null
    this.consecutiveFailures = 0
  }

  private async compensatingHyperliquidClose(ctx: Context, hlSideOpened: OrderSide, sizeBtc: number): Promise<void> {
    try {
      await ctx.hyperliquid!.closePosition(hlSideOpened, sizeBtc)
      ctx.log.info('funding-arb open: compensating hl close succeeded')
    } catch (err) {
      ctx.log.error('funding-arb open: compensating hl close FAILED — naked HL leg', { error: (err as Error).message })
      await ctx.alert.send({
        type: 'error',
        title: 'funding-arb: CRITICAL — naked Hyperliquid leg',
        description: `Failed to compensate-close ${hlSideOpened} ${sizeBtc} BTC after Twilight open failed.`,
      })
    }
  }

  private async unwindBothLegs(ctx: Context, twilightAccountIndex: number, hlSideOpened: OrderSide, sizeBtc: number): Promise<void> {
    await this.compensatingHyperliquidClose(ctx, hlSideOpened, sizeBtc)
    try {
      await ctx.twilight.closeTrade(twilightAccountIndex)
    } catch (err) {
      ctx.log.error('funding-arb unwind: twilight close failed', { error: (err as Error).message })
    }
  }

  private recordFailure(ctx: Context, stage: string, err: Error): void {
    this.consecutiveFailures++
    this.errorCount++
    ctx.log.error(`funding-arb ${stage} failed`, { error: err.message, consecutiveFailures: this.consecutiveFailures })
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.disabled = true
      void ctx.alert.send({
        type: 'error',
        title: 'funding-arb: per-strategy killswitch activated',
        description: `${this.consecutiveFailures} consecutive failures (last: ${stage}). Strategy disabled.`,
      })
    }
  }

  private rehydratePositionFromDb(): void {
    const open = this.ctx.db.listPositions({ strategyId: this.id, status: 'open' })
    if (open.length === 0) return
    // Best-effort rehydration: enough to avoid opening a second position. Full reconciliation requires querying both venues.
    const p = open[0]
    this.position = {
      positionDbId: p.id,
      twilightAccountIndex: -1,         // unknown after restart; close path uses DB account record if present
      twilightSide: p.side,
      twilightEntryPrice: p.entryPrice,
      twilightSizeSats: p.size,
      hyperliquidSide: p.side === 'LONG' ? 'SHORT' : 'LONG',
      hyperliquidEntryPrice: p.entryPrice,
      hyperliquidSize: 0,
      openedAt: Date.parse(p.openedAt),
    }
    const activeAcct = this.ctx.db.listAccounts({ exchange: 'twilight', status: 'active' }).find(a => a.balance >= p.size)
    if (activeAcct) this.position.twilightAccountIndex = activeAcct.accountIndex
  }

  async stop(): Promise<void> {
    this.running = false
  }

  status(): StrategyInfo {
    return {
      id: this.id,
      status: this.disabled ? 'error' : this.running ? 'active' : 'stopped',
      config: this.config as unknown as StrategyConfig,
      lastTick: this.lastTick,
      tickCount: this.tickCount,
      errorCount: this.errorCount,
    }
  }
}

function signFromSide(side: OrderSide): number {
  return side === 'SHORT' ? 1 : -1
}
