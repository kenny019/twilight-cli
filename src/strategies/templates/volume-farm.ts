import type {
  Strategy,
  StrategyConfig,
  StrategyInfo,
  Context,
  OrderSide,
  TwilightAccount,
} from '../../types/index.js'
import type { ProposableStrategy, TradeProposal, AgentEvaluation } from '../../types/agent.js'
import { DEFAULT_EVALUATION } from '../../types/agent.js'

interface VolumeFarmConfig {
  positionSizeSats: number               // size per round-trip on Twilight
  checkIntervalMs: number                // tick interval (each tick = one round-trip attempt)
  dedicatedAccountIndices: number[]      // empty = any idle Coin account
  hyperliquidLeverage: number
  hyperliquidMarginBufferUsdc: number    // require balance >= roundMargin + buffer
  dailyVolumeCapSats: number             // cumulative Twilight notional/day (both sides counted)
  maxConsecutiveFailures: number         // trip per-strategy killswitch after N
  sideRotation: 'alternate' | 'random' | 'long-only' | 'short-only'
}

interface DailyVolume {
  date: string   // YYYY-MM-DD UTC
  sats: number
}

export class VolumeFarmStrategy implements Strategy, ProposableStrategy {
  id = 'volume-farm'
  name = 'Volume Farm'
  description = 'Generates hedged round-trip volume on Twilight to qualify for trading-volume points programs, with HL hedge neutralizing price risk.'
  configSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      positionSizeSats:             { type: 'number' },
      checkIntervalMs:              { type: 'number' },
      dedicatedAccountIndices:      { type: 'array', items: { type: 'number' } },
      hyperliquidLeverage:          { type: 'number' },
      hyperliquidMarginBufferUsdc:  { type: 'number' },
      dailyVolumeCapSats:           { type: 'number' },
      maxConsecutiveFailures:       { type: 'number' },
      sideRotation:                 { type: 'string', enum: ['alternate', 'random', 'long-only', 'short-only'] },
    },
    required: ['positionSizeSats', 'checkIntervalMs', 'dedicatedAccountIndices'],
  }

  private config!: VolumeFarmConfig
  private ctx!: Context
  private tickCount = 0
  private errorCount = 0
  private lastTick: string | null = null
  private running = true
  private disabled = false
  private consecutiveFailures = 0
  private tickInFlight: Promise<void> | null = null
  private lastSide: OrderSide = 'SHORT'              // alternate flips it to LONG first
  private dailyVolume: DailyVolume = { date: '', sats: 0 }
  private totalVolume = 0                            // lifetime since process start

  async init(config: StrategyConfig, ctx: Context): Promise<void> {
    this.ctx = ctx
    this.config = {
      positionSizeSats:            5_000,
      checkIntervalMs:             30_000,
      dedicatedAccountIndices:     [],
      hyperliquidLeverage:         1,
      hyperliquidMarginBufferUsdc: 5,
      dailyVolumeCapSats:          50_000_000,        // ~$385 notional/day default
      maxConsecutiveFailures:      3,
      sideRotation:                'alternate',
      ...config as Partial<VolumeFarmConfig>,
    }
  }

  async start(): Promise<void> { this.running = true }
  async stop(): Promise<void>  { this.running = false }

  status(): StrategyInfo {
    return {
      id: this.id, status: this.running && !this.disabled ? 'active' : 'stopped',
      tickCount: this.tickCount, errorCount: this.errorCount, lastTick: this.lastTick,
      config: { ...this.config, totalVolume: this.totalVolume, dailyVolumeSats: this.dailyVolume.sats, dailyVolumeDate: this.dailyVolume.date },
    }
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = this.runTick().finally(() => { this.tickInFlight = null })
    return this.tickInFlight
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.disabled) return
    this.lastTick = new Date().toISOString()

    try {
      const proposal = await this.propose(this.ctx)
      if (!proposal) return
      await this.execute(this.ctx, DEFAULT_EVALUATION)
      this.tickCount++
    } catch (err) {
      this.errorCount++
      this.ctx.log.error('volume-farm tick error', { error: (err as Error).message })
    }
  }

  // Propose: produce a no-op proposal whenever conditions allow a round-trip.
  // The actual round-trip happens inside execute().
  async propose(ctx: Context): Promise<TradeProposal | null> {
    if (this.disabled) return null
    if (await ctx.risk.isKillSwitchActive()) return null
    if (!ctx.hyperliquid) {
      ctx.log.debug('volume-farm: hyperliquid client not configured — inert')
      return null
    }

    // Reset daily counter on UTC day rollover
    const todayUtc = new Date().toISOString().slice(0, 10)
    if (this.dailyVolume.date !== todayUtc) {
      this.dailyVolume = { date: todayUtc, sats: 0 }
    }
    if (this.dailyVolume.sats >= this.config.dailyVolumeCapSats) {
      ctx.log.debug('volume-farm: daily volume cap reached', { date: this.dailyVolume.date, sats: this.dailyVolume.sats })
      return null
    }

    return {
      strategyId: this.id,
      action: 'open',
      side: this.pickSide(),
      sizeSats: this.config.positionSizeSats,
      entryPrice: 0,                                  // filled-in by execute
      leverage: 1,
      reason: `volume-farm round #${this.tickCount + 1} dailyVol=${this.dailyVolume.sats}`,
      marketSnapshot: {
        price: 0, twilightFundingRate: 0, binanceFundingRate: 0,
        differential: 0, timestamp: new Date().toISOString(),
      },
    }
  }

  private pickSide(): OrderSide {
    switch (this.config.sideRotation) {
      case 'long-only':  return 'LONG'
      case 'short-only': return 'SHORT'
      case 'random':     return Math.random() < 0.5 ? 'LONG' : 'SHORT'
      case 'alternate':
      default:           return this.lastSide === 'LONG' ? 'SHORT' : 'LONG'
    }
  }

  async execute(ctx: Context, _evaluation: AgentEvaluation): Promise<void> {
    if (this.disabled || !ctx.hyperliquid) return
    const hl = ctx.hyperliquid
    const cfg = this.config

    // Pick an idle Twilight account
    const accounts = await ctx.twilight.walletAccounts()
    const account = this.pickAccount(accounts)
    if (!account) {
      ctx.log.warn('volume-farm: no eligible idle Coin account', {
        dedicated: cfg.dedicatedAccountIndices,
        requiredSize: cfg.positionSizeSats,
      })
      return
    }

    // Sample prices for sizing
    const [twilightMark, hlMark] = await Promise.all([
      ctx.twilight.marketPrice(),
      hl.getMarkPrice(),
    ])

    // HL margin check
    const sizeBtc = hl.quantizeBtcSize(cfg.positionSizeSats, hlMark)
    const requiredMargin = (sizeBtc * hlMark) / cfg.hyperliquidLeverage
    const hlBalance = await hl.getBalance()
    if (hlBalance < requiredMargin + cfg.hyperliquidMarginBufferUsdc) {
      ctx.log.warn('volume-farm: insufficient HL balance', { hlBalance, requiredMargin, buffer: cfg.hyperliquidMarginBufferUsdc })
      return
    }

    const twilightSide = this.pickSide()
    const hlSide: OrderSide = twilightSide === 'LONG' ? 'SHORT' : 'LONG'

    // ── Atomic open: HL first, then Twilight ────────────────────────
    const hlOpen = await hl.openPosition(hlSide, sizeBtc, cfg.hyperliquidLeverage).catch((e: Error) => ({ error: e }))
    if ('error' in hlOpen) {
      this.recordFailure(ctx, 'hl-open', hlOpen.error)
      return
    }
    if (hlOpen.status !== 'filled') {
      ctx.log.warn('volume-farm: HL open not filled', { hlOpen })
      this.recordFailure(ctx, 'hl-open-status', new Error(`status=${hlOpen.status}`))
      return
    }

    const twOpen = await ctx.twilight.openTrade(account.index, twilightSide, twilightMark, 1).catch((e: Error) => ({ error: e }))
    if ('error' in twOpen) {
      ctx.log.error('volume-farm: Twilight open failed — closing HL hedge', { err: twOpen.error.message })
      await this.safeCompensatingClose(ctx, hlSide, hlOpen.size)
      this.recordFailure(ctx, 'tw-open', twOpen.error)
      return
    }

    this.lastSide = twilightSide

    // ── Atomic close: HL first, then Twilight ───────────────────────
    const hlClose = await hl.closePosition(hlSide, hlOpen.size).catch((e: Error) => ({ error: e }))
    if ('error' in hlClose) {
      ctx.log.error('volume-farm: HL close failed — Twilight still open, will attempt close anyway', { err: hlClose.error.message })
      // Continue to close Twilight regardless; HL position will need manual cleanup
    }

    const twClose = await ctx.twilight.closeTrade(account.index).catch((e: Error) => ({ error: e }))
    if ('error' in twClose) {
      ctx.log.error('volume-farm: Twilight close failed — naked HL leg may exist', { err: twClose.error.message })
      this.recordFailure(ctx, 'tw-close', twClose.error)
      return
    }

    // ── Unlock the settled account, then transfer to rotate to a fresh
    //    account. Without the transfer, the next open-trade against the
    //    same index fails with "Value Witness Verification Failed" because
    //    the account still carries the previous order's witness. ──
    try {
      await ctx.twilight.unlockTrade(account.index)
    } catch (err) {
      ctx.log.warn('volume-farm: unlock-close-order failed — manual cleanup needed', { accountIndex: account.index, error: (err as Error).message })
      this.recordFailure(ctx, 'unlock', err as Error)
      return
    }
    try {
      await ctx.twilight.transfer(account.index)
    } catch (err) {
      ctx.log.warn('volume-farm: transfer (rotate) failed — account stuck in Coin/ORDERTX state, next tick will skip it', { accountIndex: account.index, error: (err as Error).message })
      this.recordFailure(ctx, 'transfer', err as Error)
      return
    }

    // ── Accounting ──────────────────────────────────────────────────
    const roundVolume = 2 * cfg.positionSizeSats     // both legs: open + close
    this.dailyVolume.sats += roundVolume
    this.totalVolume += roundVolume
    this.consecutiveFailures = 0

    ctx.log.info('volume-farm round complete', {
      side: twilightSide,
      accountIndex: account.index,
      roundVolumeSats: roundVolume,
      dailyVolumeSats: this.dailyVolume.sats,
      totalVolumeSats: this.totalVolume,
    })
  }

  private pickAccount(accounts: TwilightAccount[]): TwilightAccount | undefined {
    const cfg = this.config
    const indexFilter = cfg.dedicatedAccountIndices.length === 0
      ? () => true
      : (idx: number) => cfg.dedicatedAccountIndices.includes(idx)
    return accounts.find(a =>
      indexFilter(a.index)
      && a.onChain
      && a.ioType === 'Coin'
      && a.balance >= cfg.positionSizeSats,
    )
  }

  private async safeCompensatingClose(ctx: Context, hlSide: OrderSide, sizeBtc: number): Promise<void> {
    if (!ctx.hyperliquid) return
    try {
      await ctx.hyperliquid.closePosition(hlSide, sizeBtc)
    } catch (err) {
      ctx.log.error('volume-farm: compensating HL close FAILED — manual cleanup required', { error: (err as Error).message })
    }
  }

  private recordFailure(ctx: Context, where: string, err: Error): void {
    this.consecutiveFailures++
    ctx.log.warn('volume-farm failure', { where, error: err.message, consecutiveFailures: this.consecutiveFailures })
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.disabled = true
      ctx.log.error('volume-farm: consecutive failure cap hit — strategy disabled', {
        consecutiveFailures: this.consecutiveFailures,
      })
    }
  }
}
