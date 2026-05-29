import type {
  Strategy,
  StrategyConfig,
  StrategyInfo,
  Context,
  OrderSide,
  TwilightAccount,
  TwilightOrderStatus,
} from '../../types/index.js'
import type { ProposableStrategy, TradeProposal, AgentEvaluation } from '../../types/agent.js'
import { DEFAULT_EVALUATION } from '../../types/agent.js'

const VOLUME_KV_KEY = 'volume-farm:volume'
const DEAD_KV_KEY = 'volume-farm:dead-accounts'

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
  feeRatePerLeg: number                  // protocol fee fraction per leg (e.g. 0.0004 = 0.04%)
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
  private totalFeesSats = 0                          // cumulative estimated fees paid
  private totalMarkPnlSats = 0                       // cumulative mark-to-mark drift over holds (±)
  private replenishInFlight = false
  private lastReplenishAt = 0
  private deadAccounts = new Set<number>()           // chain-dead (UTXO not found) — never retry
  // Tunable for tests
  replenishCooldownMs = 5 * 60_000
  replenishPollIntervalMs = 3_000
  replenishPollTimeoutMs = 30_000
  replenishChildCount = 10
  replenishInterSplitMs = 1_500
  maxReclaimPerBoot = 25     // bound boot reconcile so a large backlog can't stall startup

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
      feeRatePerLeg:               0.0004,            // 0.04% market fill/settle (per market fee-rate)
      ...config as Partial<VolumeFarmConfig>,
    }
    this.loadVolumeState(ctx)
    this.loadDeadAccounts(ctx)
  }

  // Volume/cost counters persist across restarts so the daily cap can't be
  // bypassed by a mid-day restart (propose() resets the daily figure on UTC
  // rollover regardless of what was loaded).
  private loadVolumeState(ctx: Context): void {
    const db = ctx.db as { getKV?: (k: string) => string | undefined } | undefined
    if (typeof db?.getKV !== 'function') return
    try {
      const raw = db.getKV(VOLUME_KV_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as Partial<{ date: string; dailySats: number; totalSats: number; totalFeesSats: number; totalMarkPnlSats: number }>
      this.dailyVolume = { date: s.date ?? '', sats: s.dailySats ?? 0 }
      this.totalVolume = s.totalSats ?? 0
      this.totalFeesSats = s.totalFeesSats ?? 0
      this.totalMarkPnlSats = s.totalMarkPnlSats ?? 0
      ctx.log.info('volume-farm: restored volume state', { date: this.dailyVolume.date, dailySats: this.dailyVolume.sats, totalSats: this.totalVolume })
    } catch (err) {
      ctx.log.warn('volume-farm: failed to restore volume state', { error: (err as Error).message })
    }
  }

  private persistVolumeState(ctx: Context): void {
    const db = ctx.db as { setKV?: (k: string, v: string) => void } | undefined
    if (typeof db?.setKV !== 'function') return
    try {
      db.setKV(VOLUME_KV_KEY, JSON.stringify({
        date: this.dailyVolume.date,
        dailySats: this.dailyVolume.sats,
        totalSats: this.totalVolume,
        totalFeesSats: this.totalFeesSats,
        totalMarkPnlSats: this.totalMarkPnlSats,
      }))
    } catch (err) {
      ctx.log.warn('volume-farm: failed to persist volume state', { error: (err as Error).message })
    }
  }

  private loadDeadAccounts(ctx: Context): void {
    const db = ctx.db as { getKV?: (k: string) => string | undefined } | undefined
    if (typeof db?.getKV !== 'function') return
    try {
      const raw = db.getKV(DEAD_KV_KEY)
      if (!raw) return
      const arr = JSON.parse(raw) as number[]
      this.deadAccounts = new Set(arr)
      if (arr.length) ctx.log.info('volume-farm: loaded chain-dead account skip-set', { count: arr.length, indices: arr })
    } catch (err) {
      ctx.log.warn('volume-farm: failed to load dead-account skip-set', { error: (err as Error).message })
    }
  }

  // Permanently skip an account whose UTXO no longer exists on-chain. Such an
  // account can never be transferred/unlocked, so retrying it just wastes ~30s
  // of relayer-cli retries on every boot and dry-pool tick. Persisted so the
  // skip survives restarts.
  private markDead(ctx: Context, index: number): void {
    if (this.deadAccounts.has(index)) return
    this.deadAccounts.add(index)
    ctx.log.warn('volume-farm: account is chain-dead (UTXO not found) — adding to skip-set', { accountIndex: index, deadCount: this.deadAccounts.size })
    const db = ctx.db as { setKV?: (k: string, v: string) => void } | undefined
    if (typeof db?.setKV !== 'function') return
    try {
      db.setKV(DEAD_KV_KEY, JSON.stringify([...this.deadAccounts]))
    } catch (err) {
      ctx.log.warn('volume-farm: failed to persist dead-account skip-set', { error: (err as Error).message })
    }
  }

  async start(): Promise<void> { this.running = true }
  async stop(): Promise<void>  { this.running = false }

  status(): StrategyInfo {
    return {
      id: this.id, status: this.running && !this.disabled ? 'active' : 'stopped',
      tickCount: this.tickCount, errorCount: this.errorCount, lastTick: this.lastTick,
      config: {
        ...this.config,
        totalVolume: this.totalVolume,
        dailyVolumeSats: this.dailyVolume.sats,
        dailyVolumeDate: this.dailyVolume.date,
        totalFeesSats: this.totalFeesSats,
        totalMarkPnlSats: this.totalMarkPnlSats,
        netCostSats: this.totalFeesSats - this.totalMarkPnlSats,
      },
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

    // Pick an idle Twilight account. If none is fresh (Coin/-), try reclaiming
    // one stuck account (Coin/ORDERTX residue, or a Memo account left by an
    // interrupted round), then fall back to auto-replenishing from the wallet.
    let accounts = await ctx.twilight.walletAccounts()
    let account = this.pickAccount(accounts)
    if (!account) {
      const recovered = await this.tryReclaimStuckAccount(ctx, accounts)
      if (recovered) {
        accounts = await ctx.twilight.walletAccounts()
        account = this.pickAccount(accounts)
      }
    }
    if (!account) {
      const replenishResult = await this.tryReplenish(ctx)
      if (replenishResult === 'replenished') {
        accounts = await ctx.twilight.walletAccounts()
        account = this.pickAccount(accounts)
        if (!account) {
          this.recordFailure(ctx, 'no-eligible-account', new Error('replenish reported success but no account picked'))
          return
        }
      } else if (replenishResult === 'cooldown') {
        ctx.log.warn('volume-farm: pool dry, replenish on cooldown — strategy idle until it expires')
        return
      } else {
        this.recordFailure(ctx, 'no-eligible-account', new Error(`pool dry; replenish=${replenishResult}`))
        return
      }
    }

    const entryMark = await ctx.twilight.marketPrice()
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
    const twOpen = await ctx.twilight.openTrade(account.index, twilightSide, entryMark, 1).catch((e: Error) => ({ error: e }))
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

    // Sample mark just before close to measure mark-to-mark drift over the
    // hold (the only price cost in hedge:none mode, since fills are at mark).
    const exitMark = await ctx.twilight.marketPrice().catch(() => entryMark)

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

    // Cost estimate. Fee: positionSize × feeRatePerLeg × 2 legs. Mark drift:
    // signed mark-to-mark over the hold (LONG profits when mark rose). Both in
    // sats so net cost = fees − markPnl is directly comparable to volume.
    const feeEstSats = Math.round(2 * cfg.positionSizeSats * cfg.feeRatePerLeg)
    const markRet = entryMark > 0 ? (exitMark - entryMark) / entryMark : 0
    const dir = twilightSide === 'LONG' ? 1 : -1
    const markPnlSats = Math.round(dir * markRet * cfg.positionSizeSats)
    this.totalFeesSats += feeEstSats
    this.totalMarkPnlSats += markPnlSats
    this.persistVolumeState(ctx)

    ctx.log.info('volume-farm round complete', {
      side: twilightSide,
      accountIndex: account.index,
      roundVolumeSats: roundVolume,
      dailyVolumeSats: this.dailyVolume.sats,
      totalVolumeSats: this.totalVolume,
      entryMark,
      exitMark,
      feeEstSats,
      markPnlSats,
      netCostSats: this.totalFeesSats - this.totalMarkPnlSats,
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

  private indexAllowed(idx: number): boolean {
    const ded = this.config.dedicatedAccountIndices
    return ded.length === 0 || ded.includes(idx)
  }

  // A funded account stuck mid-lifecycle that should be reclaimed to fresh:
  //   • Coin/ORDERTX with balance — unlocked but never rotated.
  //   • Memo with balance — an order is still attached (either an orphaned
  //     OPEN position from a crash, or a settled-but-unrotated close).
  // Empty Coin/ORDERTX husks (balance 0, post-rotation residue) are ignored.
  private isStuck(a: TwilightAccount): boolean {
    if (this.deadAccounts.has(a.index)) return false
    if (!a.onChain || !this.indexAllowed(a.index)) return false
    if (a.ioType === 'Coin' && a.txType === 'ORDERTX' && a.balance >= this.config.positionSizeSats) return true
    if (a.ioType === 'Memo' && a.balance > 0) return true
    return false
  }

  // Drive one stuck account back to fresh Coin/-. Returns the order status it
  // acted on ('FILLED' = an orphaned open position was closed), 'ROTATE' for a
  // plain Coin/ORDERTX rotation, or null if it could not act. Best-effort:
  // a failure leaves the account for a later attempt.
  private async reclaimAccount(ctx: Context, account: TwilightAccount): Promise<TwilightOrderStatus | 'ROTATE' | null> {
    try {
      if (account.ioType === 'Coin' && account.txType === 'ORDERTX') {
        await ctx.twilight.transfer(account.index)
        ctx.log.info('volume-farm: reclaimed Coin/ORDERTX by rotating', { accountIndex: account.index })
        return 'ROTATE'
      }
      // Memo: inspect the attached order to decide close vs unlock.
      const { orderStatus } = await ctx.twilight.queryTrade(account.index)
      if (orderStatus === 'FILLED') {
        // Orphaned OPEN position (a crash left it mid-round). The farm is always
        // flat between rounds, so close → settle → unlock → rotate.
        await ctx.twilight.closeTrade(account.index, { skipRotation: true })
        await ctx.twilight.waitForOrderStatus(account.index, 'SETTLED', { timeoutMs: 30_000 })
        await ctx.twilight.unlockTrade(account.index)
        await ctx.twilight.transfer(account.index)
        ctx.log.warn('volume-farm: reclaimed ORPHANED open position', { accountIndex: account.index })
        return 'FILLED'
      }
      if (orderStatus === 'SETTLED') {
        await ctx.twilight.unlockTrade(account.index)
        await ctx.twilight.transfer(account.index)
        ctx.log.info('volume-farm: reclaimed settled-but-unrotated account', { accountIndex: account.index })
        return 'SETTLED'
      }
      ctx.log.debug('volume-farm: stuck account in transient state — skipping', { accountIndex: account.index, orderStatus })
      return null
    } catch (err) {
      const msg = (err as Error).message
      if (/utxo not found/i.test(msg)) {
        // Chain-dead: the UTXO is gone, so this can never succeed. Skip forever.
        this.markDead(ctx, account.index)
      } else {
        ctx.log.warn('volume-farm: reclaim failed — will retry later', { accountIndex: account.index, error: msg })
      }
      return null
    }
  }

  // Tick-time: reclaim a single stuck account so capital recycles instead of
  // leaking into stranded Memo/ORDERTX states. Returns true if it acted.
  private async tryReclaimStuckAccount(ctx: Context, accounts: TwilightAccount[]): Promise<boolean> {
    const stuck = accounts.find(a => this.isStuck(a))
    if (!stuck) return false
    return (await this.reclaimAccount(ctx, stuck)) !== null
  }

  // Boot-time: scan all accounts and reclaim stuck ones (bounded by
  // maxReclaimPerBoot) before the scheduler starts ticking. Catches positions
  // left OPEN by a crash (orphans → unhedged exposure) and settled-but-unrotated
  // residue. Alerts if any orphaned open position was found. Assumes this is the
  // only strategy holding positions (true in production: one strategy, flat
  // between rounds), so any attached order is its own to reclaim.
  async reconcileStuck(ctx: Context): Promise<{ reclaimed: number; orphans: number; remaining: number }> {
    const accounts = await ctx.twilight.walletAccounts()
    const stuck = accounts.filter(a => this.isStuck(a))
    if (stuck.length === 0) return { reclaimed: 0, orphans: 0, remaining: 0 }

    const batch = stuck.slice(0, this.maxReclaimPerBoot)
    const remaining = stuck.length - batch.length
    ctx.log.info('volume-farm: boot reconcile — stuck accounts found', {
      total: stuck.length, processing: batch.length, remaining, indices: batch.map(a => a.index),
    })

    let reclaimed = 0
    let orphans = 0
    for (const a of batch) {
      const result = await this.reclaimAccount(ctx, a)
      if (result !== null) reclaimed++
      if (result === 'FILLED') orphans++
    }

    if (orphans > 0) {
      void ctx.alert.send({
        type: 'risk',
        title: 'volume-farm: orphaned open position(s) reclaimed on boot',
        description: `${orphans} account(s) held an OPEN position after restart (unhedged exposure) and were closed. Reclaimed ${reclaimed}/${batch.length}; ${remaining} stuck account(s) remain.`,
        fields: [
          { name: 'orphans', value: String(orphans), inline: true },
          { name: 'reclaimed', value: String(reclaimed), inline: true },
          { name: 'remaining', value: String(remaining), inline: true },
        ],
      })
    }
    ctx.log.info('volume-farm: boot reconcile complete', { reclaimed, orphans, remaining })
    return { reclaimed, orphans, remaining }
  }

  // Auto-fund fresh Coin/- accounts from the main wallet when the pool runs
  // dry. relayer-cli v0.1.2 rejects multi-balance splits with "No new
  // accounts to create", so we split 1-by-1.
  private async tryReplenish(ctx: Context): Promise<'replenished' | 'cooldown' | 'no-funds' | 'failed'> {
    if (this.replenishInFlight) return 'cooldown'
    if (Date.now() - this.lastReplenishAt < this.replenishCooldownMs) return 'cooldown'

    this.replenishInFlight = true
    this.lastReplenishAt = Date.now()
    const cfg = this.config
    const childSize = Math.max(cfg.positionSizeSats * 2, 5_000)
    const childCount = this.replenishChildCount
    const fundAmount = childSize * childCount

    try {
      const { sats } = await ctx.twilight.walletBalance()
      if (sats < fundAmount) {
        ctx.log.error('volume-farm: replenish — wallet sats below fund amount', { walletSats: sats, required: fundAmount })
        return 'no-funds'
      }

      const fundResult = await ctx.twilight.fund(fundAmount)
      ctx.log.info('volume-farm: replenish funded parent', { parentIndex: fundResult.accountIndex, fundAmount, childCount, childSize })

      for (let i = 0; i < childCount; i++) {
        try {
          await ctx.twilight.split(fundResult.accountIndex, [childSize])
        } catch (err) {
          ctx.log.warn('volume-farm: replenish split failed midway', { i, error: (err as Error).message })
          break
        }
        if (this.replenishInterSplitMs > 0) await new Promise(r => setTimeout(r, this.replenishInterSplitMs))
      }

      const deadline = Date.now() + this.replenishPollTimeoutMs
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, this.replenishPollIntervalMs))
        const fresh = (await ctx.twilight.walletAccounts())
          .filter(a => a.onChain
            && a.ioType === 'Coin'
            && (a.txType === '-' || a.txType === undefined)
            && a.balance >= cfg.positionSizeSats)
        if (fresh.length >= 1) {
          ctx.log.info('volume-farm: replenish complete', { freshCount: fresh.length, childSize })
          return 'replenished'
        }
      }
      ctx.log.warn('volume-farm: replenish timed out waiting for children')
      return 'failed'
    } catch (err) {
      ctx.log.error('volume-farm: replenish exception', { error: (err as Error).message })
      return 'failed'
    } finally {
      this.replenishInFlight = false
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
    this.errorCount++
    ctx.log.warn('volume-farm failure', { where, error: err.message, consecutiveFailures: this.consecutiveFailures })
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.disabled = true
      ctx.log.error('volume-farm: consecutive failure cap hit — strategy disabled', {
        consecutiveFailures: this.consecutiveFailures,
      })
      // Fire-and-forget: a tripped killswitch leaves the bot inert with the
      // process alive (launchd won't restart it), so this alert is the only
      // signal an operator gets. Mirrors funding-arb/market-maker.
      void ctx.alert.send({
        type: 'error',
        title: 'volume-farm: per-strategy killswitch activated',
        description: `${this.consecutiveFailures} consecutive failures (last: ${where} — ${err.message}). Strategy disabled until manual re-enable.`,
        fields: [
          { name: 'strategy', value: this.id, inline: true },
          { name: 'lastFailure', value: where, inline: true },
          { name: 'consecutiveFailures', value: String(this.consecutiveFailures), inline: true },
        ],
      })
    }
  }
}
