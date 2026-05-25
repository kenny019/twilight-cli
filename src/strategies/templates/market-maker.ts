import type {
  Strategy,
  StrategyConfig,
  StrategyInfo,
  Context,
  TwilightAccount,
  OrderSide,
  TwilightOrderStatus,
} from '../../types/index.js'

interface MarketMakerConfig {
  layers: number
  layerStepBps: number
  quoteSizeSats: number
  requoteIntervalMs: number
  requoteBps: number
  maxQuoteAgeMs: number
  leverage: number
  maxInventorySats: number
  walletFloorSats: number
  bypassCooldown: boolean
  minNyks: number
}

interface QuoteState {
  side: OrderSide
  layer: number
  postedAt: number
  postedPrice: number
  sizeSats: number
}

const MAX_CONSECUTIVE_REJECTIONS = 5
const POST_VERIFY_DELAY_MS = 500

export class MarketMakerStrategy implements Strategy {
  id = 'market-maker'
  name = 'Market Maker'
  description = 'Layered passive limit-order market maker on Twilight perps'

  configSchema = {
    type: 'object',
    properties: {
      layers:            { type: 'number', description: 'Quote layers per side' },
      layerStepBps:      { type: 'number', description: 'Spread between layers in bps' },
      quoteSizeSats:     { type: 'number', description: 'Per-quote size in satoshis' },
      requoteIntervalMs: { type: 'number', description: 'Base tick interval' },
      requoteBps:        { type: 'number', description: 'Mid-price drift threshold (bps) that forces requote' },
      maxQuoteAgeMs:     { type: 'number', description: 'Max age before forced requote' },
      leverage:          { type: 'number', description: 'Position leverage for quotes' },
      maxInventorySats:  { type: 'number', description: 'Net inventory cap before suppressing one side' },
      walletFloorSats:   { type: 'number', description: 'Killswitch threshold on wallet sats balance' },
      bypassCooldown:    { type: 'boolean', description: 'Bypass per-strategy cooldown checks' },
      minNyks:           { type: 'number', description: 'Minimum NYKS gas balance below which strategy halts' },
    },
    required: ['layers', 'layerStepBps', 'quoteSizeSats', 'requoteIntervalMs', 'leverage'],
  }

  config!: MarketMakerConfig
  private ctx!: Context
  private tickCount = 0
  private errorCount = 0
  private lastTick: string | null = null
  private running = true

  private quoteState = new Map<number, QuoteState>()
  private lastQuotedMid: number | null = null
  private lastRequoteAt = 0
  private tickInFlight: Promise<void> | null = null
  private inventoryNetSats = 0
  private consecutiveRejections = 0
  private lastFillAt: string | null = null

  async init(config: StrategyConfig, ctx: Context): Promise<void> {
    this.config = {
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
      ...(config as unknown as Partial<MarketMakerConfig>),
    }
    this.ctx = ctx

    await this.bootRecover()
    this.rebuildInventoryFromDb()
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = this.runTick().finally(() => {
      this.tickInFlight = null
    })
    return this.tickInFlight
  }

  private async runTick(): Promise<void> {
    const ctx = this.ctx
    try {
      if (await ctx.risk.isKillSwitchActive()) return

      const balance = await ctx.twilight.walletBalance()
      if (balance.sats < this.config.walletFloorSats) {
        ctx.log.warn('Wallet floor breached — activating killswitch', { sats: balance.sats, floor: this.config.walletFloorSats })
        await ctx.risk.activateKillSwitch()
        await ctx.alert.send({
          type: 'risk',
          title: 'MM killswitch: wallet floor',
          description: `Wallet sats ${balance.sats} below floor ${this.config.walletFloorSats}`,
        })
        await this.cancelAllQuotes('wallet floor')
        return
      }
      if (balance.nyks < this.config.minNyks) {
        ctx.log.warn('NYKS gas low — activating killswitch', { nyks: balance.nyks, floor: this.config.minNyks })
        await ctx.risk.activateKillSwitch()
        await ctx.alert.send({
          type: 'risk',
          title: 'MM killswitch: gas floor',
          description: `Wallet NYKS ${balance.nyks} below floor ${this.config.minNyks}`,
        })
        await this.cancelAllQuotes('gas floor')
        return
      }

      const mid = await ctx.twilight.marketPrice()
      if (!Number.isFinite(mid) || mid <= 0) {
        ctx.log.warn('Invalid mid — skipping tick', { mid })
        return
      }

      const accounts = await ctx.twilight.walletAccounts()
      await this.detectFills(accounts)

      if (this.shouldRequote(mid)) {
        await this.repostQuotes(mid, accounts)
      }
    } catch (err) {
      this.errorCount++
      ctx.log.error('market-maker tick error', { error: (err as Error).message })
    } finally {
      this.tickCount++
      this.lastTick = new Date().toISOString()
    }
  }

  // ─── Boot recovery ───────────────────────────────────────────────

  private async bootRecover(): Promise<void> {
    const ctx = this.ctx
    const accounts = await ctx.twilight.walletAccounts()
    const occupied = accounts.filter(a => a.ioType !== 'Coin')

    for (const acct of occupied) {
      try {
        const query = await ctx.twilight.queryTrade(acct.index)
        const status: TwilightOrderStatus = query.orderStatus
        if (status === 'PENDING') {
          ctx.log.info('Boot recovery: cancelling PENDING quote', { index: acct.index })
          await ctx.twilight.cancelTrade(acct.index)
        } else if (status === 'FILLED') {
          ctx.log.info('Boot recovery: closing FILLED position', { index: acct.index })
          await ctx.twilight.closeTrade(acct.index)
          // Record an inventory marker so net inventory math stays consistent
          // when DB had no record (e.g., crash before persistence).
          const existing = ctx.db.listPositions({ strategyId: this.id, status: 'open' })
            .find(p => Math.round(p.size) === acct.balance)
          if (!existing) {
            const pos = ctx.db.createPosition({
              strategyId: this.id,
              exchange: 'twilight',
              side: 'LONG',
              entryPrice: 0,
              size: acct.balance,
              leverage: this.config.leverage,
              status: 'open',
            })
            ctx.db.updatePosition(pos.id, { status: 'closed', closedAt: new Date().toISOString() })
          }
        } else {
          ctx.log.warn('Boot recovery: unhandled order_status — leaving for manual ops', { index: acct.index, status })
        }
      } catch (err) {
        ctx.log.error('Boot recovery failed for account', { index: acct.index, error: (err as Error).message })
      }
    }
  }

  private rebuildInventoryFromDb(): void {
    const open = this.ctx.db.listPositions({ strategyId: this.id, status: 'open' })
    let net = 0
    for (const pos of open) {
      net += pos.side === 'LONG' ? pos.size : -pos.size
    }
    this.inventoryNetSats = net
  }

  // ─── Fill detection ──────────────────────────────────────────────

  /**
   * On Twilight, FILLED limit orders stay in Memo state — ioType alone can't
   * distinguish resting from filled. We query order_status per Memo account
   * in quoteState to get the truth. Coin/missing means the account was
   * cancelled-and-reclaimed; anything FILLED counts as a fill.
   */
  private async detectFills(accounts: TwilightAccount[]): Promise<void> {
    const ctx = this.ctx
    const ioByIndex = new Map(accounts.map(a => [a.index, a.ioType]))

    for (const [index, quote] of Array.from(this.quoteState.entries())) {
      const io = ioByIndex.get(index)
      if (io === 'Coin' || io === undefined) {
        // Account dropped back to Coin (or vanished) — cancel landed, no fill.
        this.quoteState.delete(index)
        continue
      }
      // Memo (or any other parked state) — query the relayer for ground truth.
      let status: TwilightOrderStatus
      try {
        const query = await ctx.twilight.queryTrade(index)
        status = query.orderStatus
      } catch (err) {
        ctx.log.warn('detectFills queryTrade failed', { index, error: (err as Error).message })
        continue
      }
      if (status === 'PENDING') continue // still resting on the book
      if (status !== 'FILLED') {
        // CANCELLED, SETTLED, LIQUIDATED, UNKNOWN — terminal-but-not-our-fill;
        // drop the tracker entry so we don't keep re-querying.
        this.quoteState.delete(index)
        continue
      }
      // FILLED — record the fill.
      const fillPrice = quote.postedPrice
      const sizeSats = quote.sizeSats
      const side = quote.side

      const position = ctx.db.createPosition({
        strategyId: this.id,
        exchange: 'twilight',
        side,
        entryPrice: fillPrice,
        size: sizeSats,
        leverage: this.config.leverage,
        status: 'open',
      })
      ctx.db.createTrade({
        positionId: position.id,
        type: 'open',
        price: fillPrice,
        size: sizeSats,
        fee: 0,
        pnl: 0,
      })
      this.inventoryNetSats += side === 'LONG' ? sizeSats : -sizeSats
      this.lastFillAt = new Date().toISOString()
      this.quoteState.delete(index)

      ctx.log.info('MM fill detected', {
        index,
        side,
        layer: quote.layer,
        sizeSats,
        fillPrice,
        inventoryNetSats: this.inventoryNetSats,
        holdSinceMs: Date.now() - quote.postedAt,
      })
    }
  }

  // ─── Repost decision ─────────────────────────────────────────────

  private shouldRequote(mid: number): boolean {
    if (this.lastQuotedMid === null) return true
    if (Date.now() - this.lastRequoteAt > this.config.maxQuoteAgeMs) return true
    const drift = Math.abs(mid - this.lastQuotedMid) / mid
    return drift > this.config.requoteBps / 10_000
  }

  private async repostQuotes(mid: number, accountsArg: TwilightAccount[]): Promise<void> {
    const ctx = this.ctx

    // Cancel currently posted quotes
    for (const [index] of this.quoteState) {
      try {
        await ctx.twilight.cancelTrade(index)
      } catch (err) {
        ctx.log.warn('Cancel failed during repost', { index, error: (err as Error).message })
      }
    }
    this.quoteState.clear()

    // Refresh wallet snapshot — cancels reshape Coin set.
    const refreshed = await ctx.twilight.walletAccounts()
    const available: TwilightAccount[] = (refreshed.length ? refreshed : accountsArg)
      .filter(a => a.ioType === 'Coin' && a.onChain && a.balance >= this.config.quoteSizeSats)

    const allocations: Array<{ account: TwilightAccount; side: OrderSide; layer: number; price: number }> = []

    for (let layer = 1; layer <= this.config.layers; layer++) {
      const offset = layer * this.config.layerStepBps / 10_000

      // Buy side
      if (this.inventoryNetSats <= this.config.maxInventorySats) {
        const account = available.shift()
        if (!account) {
          ctx.log.warn('Quote pool exhausted — skipping buy quote', { layer })
        } else {
          const price = Math.round(mid * (1 - offset))
          allocations.push({ account, side: 'LONG', layer, price })
        }
      } else {
        ctx.log.info('Inventory cap hit — skipping buy', { layer, inventoryNetSats: this.inventoryNetSats })
      }

      // Sell side
      if (this.inventoryNetSats >= -this.config.maxInventorySats) {
        const account = available.shift()
        if (!account) {
          ctx.log.warn('Quote pool exhausted — skipping sell quote', { layer })
        } else {
          const price = Math.round(mid * (1 + offset))
          allocations.push({ account, side: 'SHORT', layer, price })
        }
      } else {
        ctx.log.info('Inventory cap hit — skipping sell', { layer, inventoryNetSats: this.inventoryNetSats })
      }
    }

    const submittedIndices: number[] = []
    for (const alloc of allocations) {
      try {
        await ctx.twilight.openTrade(alloc.account.index, alloc.side, alloc.price, this.config.leverage, 'LIMIT')
        this.quoteState.set(alloc.account.index, {
          side: alloc.side,
          layer: alloc.layer,
          postedAt: Date.now(),
          postedPrice: alloc.price,
          sizeSats: alloc.account.balance,
        })
        submittedIndices.push(alloc.account.index)
        this.consecutiveRejections = 0
      } catch (err) {
        this.consecutiveRejections++
        ctx.log.warn('open-trade rejected', {
          index: alloc.account.index,
          side: alloc.side,
          layer: alloc.layer,
          error: (err as Error).message,
        })
        if (this.consecutiveRejections > MAX_CONSECUTIVE_REJECTIONS) {
          ctx.log.error('Consecutive rejection cap hit — activating killswitch')
          await ctx.risk.activateKillSwitch()
          await ctx.alert.send({
            type: 'error',
            title: 'MM killswitch: rejections',
            description: `>${MAX_CONSECUTIVE_REJECTIONS} consecutive open-trade rejections`,
          })
          return
        }
      }
    }

    this.lastQuotedMid = mid
    this.lastRequoteAt = Date.now()

    await this.verifySubmissions(submittedIndices)
  }

  private async verifySubmissions(submittedIndices: number[]): Promise<void> {
    if (submittedIndices.length === 0) return
    await new Promise<void>(r => setTimeout(r, POST_VERIFY_DELAY_MS))
    try {
      const accounts = await this.ctx.twilight.walletAccounts()
      const ioByIndex = new Map(accounts.map(a => [a.index, a.ioType]))
      const stuck: number[] = []
      for (const idx of submittedIndices) {
        const io = ioByIndex.get(idx)
        if (io === 'Coin' || io === undefined) {
          stuck.push(idx)
          this.quoteState.delete(idx)
        }
      }
      if (stuck.length) {
        this.ctx.log.warn('Posted quotes did not move to Memo — backing off', { stuck })
        await this.ctx.alert.send({
          type: 'error',
          title: 'MM post-submit verification failed',
          description: `Indices stuck on Coin: ${stuck.join(',')}`,
        })
      }
    } catch (err) {
      this.ctx.log.warn('Post-submit verification failed', { error: (err as Error).message })
    }
  }

  private async cancelAllQuotes(reason: string): Promise<void> {
    if (this.quoteState.size === 0) return
    this.ctx.log.info('Cancelling all quotes', { reason, count: this.quoteState.size })
    for (const [index] of this.quoteState) {
      try {
        await this.ctx.twilight.cancelTrade(index)
      } catch (err) {
        this.ctx.log.warn('Cancel failed during shutdown', { index, error: (err as Error).message })
      }
    }
    this.quoteState.clear()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.cancelAllQuotes('stop()')
  }

  status(): StrategyInfo {
    return {
      id: this.id,
      status: this.running ? 'active' : 'stopped',
      config: {
        ...(this.config as unknown as Record<string, unknown>),
        inventoryNetSats: this.inventoryNetSats,
        activeQuotes: this.quoteState.size,
        consecutiveRejections: this.consecutiveRejections,
        lastFillAt: this.lastFillAt,
      },
      lastTick: this.lastTick,
      tickCount: this.tickCount,
      errorCount: this.errorCount,
    }
  }
}
