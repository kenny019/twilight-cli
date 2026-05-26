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
  hedge: 'hyperliquid' | 'none'          // 'none' = TW-only, accepts tiny per-round price variance
  hyperliquidLeverage: number
  hyperliquidMarginBufferUsdc: number    // require balance >= roundMargin + buffer (when hedged)
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
  description = 'Generates round-trip volume on Twilight to qualify for trading-volume points programs. Hedge mode is configurable: hyperliquid (neutralizes price risk, higher fees) or none (TW-only, ~95% cheaper, tiny per-round price variance).'
  configSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      positionSizeSats:             { type: 'number' },
      checkIntervalMs:              { type: 'number' },
      dedicatedAccountIndices:      { type: 'array', items: { type: 'number' } },
      hedge:                        { type: 'string', enum: ['hyperliquid', 'none'] },
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
      hedge:                       'hyperliquid',
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
    if (this.config.hedge === 'hyperliquid' && !ctx.hyperliquid) {
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
    if (this.disabled) return
    const cfg = this.config
    const hedged = cfg.hedge === 'hyperliquid'
    if (hedged && !ctx.hyperliquid) return

    // Pick an idle Twilight account. If none is fresh (Coin/-), try
    // recovering a stale Coin/ORDERTX (interrupted-round residue) once.
    let accounts = await ctx.twilight.walletAccounts()
    let account = this.pickAccount(accounts)
    if (!account) {
      const recovered = await this.tryRecoverStaleAccount(ctx, accounts)
      if (recovered) {
        accounts = await ctx.twilight.walletAccounts()
        account = this.pickAccount(accounts)
      }
    }
    if (!account) {
      ctx.log.warn('volume-farm: no eligible fresh Coin account', {
        dedicated: cfg.dedicatedAccountIndices,
        requiredSize: cfg.positionSizeSats,
      })
      return
    }

    const twilightMark = await ctx.twilight.marketPrice()
    const twilightSide = this.pickSide()

    // ── Optional HL hedge open ─────────────────────────────────────
    let hlOpenSize = 0
    let hlSide: OrderSide = 'SHORT'
    if (hedged) {
      const hl = ctx.hyperliquid!
      const hlMark = await hl.getMarkPrice()
      const sizeBtc = hl.quantizeBtcSize(cfg.positionSizeSats, hlMark)
      const requiredMargin = (sizeBtc * hlMark) / cfg.hyperliquidLeverage
      const hlBalance = await hl.getBalance()
      if (hlBalance < requiredMargin + cfg.hyperliquidMarginBufferUsdc) {
        ctx.log.warn('volume-farm: insufficient HL balance', { hlBalance, requiredMargin, buffer: cfg.hyperliquidMarginBufferUsdc })
        return
      }
      hlSide = twilightSide === 'LONG' ? 'SHORT' : 'LONG'
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
      hlOpenSize = hlOpen.size
    }

    // ── Twilight open ──────────────────────────────────────────────
    const twOpen = await ctx.twilight.openTrade(account.index, twilightSide, twilightMark, 1).catch((e: Error) => ({ error: e }))
    if ('error' in twOpen) {
      ctx.log.error('volume-farm: Twilight open failed', { err: twOpen.error.message, hedged })
      if (hedged) await this.safeCompensatingClose(ctx, hlSide, hlOpenSize)
      this.recordFailure(ctx, 'tw-open', twOpen.error)
      return
    }

    this.lastSide = twilightSide

    // ── Wait for Twilight open to settle on-chain before issuing close.
    //    open-trade returns "FILLED" once matched, but close-trade can
    //    fail with "Failed to get tx hash, Order may be in the queue"
    //    if the open's chain tx isn't indexed yet. ──
    try {
      await ctx.twilight.waitForOrderStatus(account.index, 'FILLED', { timeoutMs: 20_000 })
    } catch (err) {
      ctx.log.warn('volume-farm: open never reached FILLED — leaving Twilight to manual reconciliation', { err: (err as Error).message })
      if (hedged) await this.safeCompensatingClose(ctx, hlSide, hlOpenSize)
      this.recordFailure(ctx, 'tw-open-wait', err as Error)
      return
    }

    // ── Optional HL hedge close (first, so hedge is flat before TW closes) ─
    if (hedged) {
      const hl = ctx.hyperliquid!
      const hlClose = await hl.closePosition(hlSide, hlOpenSize).catch((e: Error) => ({ error: e }))
      if ('error' in hlClose) {
        ctx.log.error('volume-farm: HL close failed — Twilight still open, will attempt close anyway', { err: hlClose.error.message })
        // Continue; HL position will need manual cleanup
      }
    }

    // skipRotation: we'll do unlock + transfer ourselves AFTER SETTLED.
    const twClose = await ctx.twilight.closeTrade(account.index, { skipRotation: true }).catch((e: Error) => ({ error: e }))
    if ('error' in twClose) {
      ctx.log.error('volume-farm: Twilight close failed — naked Twilight leg', { err: twClose.error.message })
      this.recordFailure(ctx, 'tw-close', twClose.error)
      return
    }

    // ── Wait for the close to settle before unlock + transfer. ──
    try {
      await ctx.twilight.waitForOrderStatus(account.index, 'SETTLED', { timeoutMs: 30_000 })
    } catch (err) {
      ctx.log.warn('volume-farm: close never reached SETTLED — skipping unlock+transfer; account left in Memo state', { accountIndex: account.index, err: (err as Error).message })
      this.recordFailure(ctx, 'tw-close-wait', err as Error)
      return
    }

    // ── Unlock the settled account (Memo → Coin), then transfer to
    //    rotate to a fresh index. Without the transfer, the next
    //    open-trade against the same index fails with "Value Witness
    //    Verification Failed". ──
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
      ctx.log.warn('volume-farm: transfer (rotate) failed — account stuck in Coin/ORDERTX, next tick will skip it', { accountIndex: account.index, error: (err as Error).message })
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
    // A fresh account (txType='-') is required. Coin/ORDERTX accounts carry
    // a previous-order witness and will be rejected by the chain with
    // "Value Witness Verification Failed". When a previous round was
    // interrupted (e.g. by a restart) and left such an account, the
    // recovery path in execute() rotates it before picking.
    return accounts.find(a =>
      indexFilter(a.index)
      && a.onChain
      && a.ioType === 'Coin'
      && (a.txType === '-' || a.txType === undefined)
      && a.balance >= cfg.positionSizeSats,
    )
  }

  // Recover a Coin/ORDERTX account by rotating it to fresh Coin/-. Used at
  // tick start when a prior round was interrupted before the post-close
  // transfer completed.
  private async tryRecoverStaleAccount(ctx: Context, accounts: TwilightAccount[]): Promise<boolean> {
    const cfg = this.config
    const indexFilter = cfg.dedicatedAccountIndices.length === 0
      ? () => true
      : (idx: number) => cfg.dedicatedAccountIndices.includes(idx)
    const stale = accounts.find(a =>
      indexFilter(a.index)
      && a.onChain
      && a.ioType === 'Coin'
      && a.txType === 'ORDERTX'
      && a.balance >= cfg.positionSizeSats,
    )
    if (!stale) return false
    try {
      await ctx.twilight.transfer(stale.index)
      ctx.log.info('volume-farm: recovered stale Coin/ORDERTX account by rotating', { accountIndex: stale.index })
      return true
    } catch (err) {
      ctx.log.warn('volume-farm: stale account rotation failed', { accountIndex: stale.index, error: (err as Error).message })
      return false
    }
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
