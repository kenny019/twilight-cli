import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import { privateKeyToAccount } from 'viem/accounts'
import type {
  HyperliquidClient,
  HyperliquidFundingEntry,
  HyperliquidOrderResult,
  HyperliquidPosition,
  OrderSide,
} from '../types/index.js'

export interface HyperliquidClientConfig {
  privateKey: string
  accountAddress: string
  coin?: string
  testnet?: boolean
  slippageBps?: number   // slippage tolerance for marketable IOC orders (default: 100 = 1%)
}

const DEFAULT_COIN = 'BTC'
const DEFAULT_SLIPPAGE_BPS = 100
const MIN_NOTIONAL_USD = 10  // Hyperliquid min order notional

interface UniverseEntry {
  szDecimals: number
  name: string
  maxLeverage: number
}

export class HyperliquidClientImpl implements HyperliquidClient {
  readonly #exchange: ExchangeClient
  readonly #info: InfoClient
  readonly #accountAddress: `0x${string}`
  readonly #coin: string
  readonly #slippageBps: number

  // Resolved lazily on first use.
  #assetIndex: number | null = null
  #szDecimals: number | null = null
  #universePromise: Promise<void> | null = null

  constructor(config: HyperliquidClientConfig) {
    if (!config.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
      throw new Error('Hyperliquid: invalid privateKey (must be 0x + 64 hex chars)')
    }
    if (!config.accountAddress || !/^0x[0-9a-fA-F]{40}$/.test(config.accountAddress)) {
      throw new Error('Hyperliquid: invalid accountAddress (must be 0x + 40 hex chars)')
    }

    this.#accountAddress = config.accountAddress as `0x${string}`
    this.#coin = config.coin ?? DEFAULT_COIN
    this.#slippageBps = config.slippageBps ?? DEFAULT_SLIPPAGE_BPS

    const transport = new HttpTransport({
      isTestnet: config.testnet ?? false,
    })
    const wallet = privateKeyToAccount(config.privateKey as `0x${string}`)
    this.#exchange = new ExchangeClient({ transport, wallet })
    this.#info = new InfoClient({ transport })
  }

  // ─── Market data ────────────────────────────────────────────────

  async getMarkPrice(coin?: string): Promise<number> {
    const idx = await this.#resolveAssetIndex(coin ?? this.#coin)
    const [, ctxs] = await this.#info.metaAndAssetCtxs()
    const ctx = ctxs[idx]
    if (!ctx) throw new Error(`Hyperliquid: asset context missing for index ${idx}`)
    const price = Number(ctx.markPx)
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Hyperliquid: invalid mark price ${ctx.markPx}`)
    }
    return price
  }

  async getFundingRate(coin?: string): Promise<number> {
    const idx = await this.#resolveAssetIndex(coin ?? this.#coin)
    const [, ctxs] = await this.#info.metaAndAssetCtxs()
    const ctx = ctxs[idx]
    if (!ctx) throw new Error(`Hyperliquid: asset context missing for index ${idx}`)
    return Number(ctx.funding)
  }

  // ─── Trading ────────────────────────────────────────────────────

  async openPosition(side: OrderSide, sizeBtc: number, _leverage: number): Promise<HyperliquidOrderResult> {
    return this.#marketOrder(side, sizeBtc, false)
  }

  async closePosition(side: OrderSide, sizeBtc: number): Promise<HyperliquidOrderResult> {
    // Close = reduce-only opposite-side market
    const closeSide: OrderSide = side === 'LONG' ? 'SHORT' : 'LONG'
    return this.#marketOrder(closeSide, sizeBtc, true)
  }

  async getPosition(coin?: string): Promise<HyperliquidPosition | null> {
    const target = coin ?? this.#coin
    const state = await this.#info.clearinghouseState({ user: this.#accountAddress })
    const entry = state.assetPositions.find(p => p.position.coin === target)
    if (!entry) return null

    const szi = Number(entry.position.szi)
    if (szi === 0) return null

    const lev = entry.position.leverage
    return {
      coin: target,
      side: szi > 0 ? 'LONG' : 'SHORT',
      entryPrice: Number(entry.position.entryPx),
      size: Math.abs(szi),
      leverage: typeof lev === 'object' ? lev.value : 1,
      unrealizedPnl: Number(entry.position.unrealizedPnl),
      liquidationPrice: entry.position.liquidationPx ? Number(entry.position.liquidationPx) : null,
    }
  }

  // ─── Account ────────────────────────────────────────────────────

  async getBalance(): Promise<number> {
    const state = await this.#info.clearinghouseState({ user: this.#accountAddress })
    return Number(state.withdrawable)
  }

  // ─── Funding history ────────────────────────────────────────────

  async getRealizedFunding(sinceMs: number, coin?: string): Promise<HyperliquidFundingEntry[]> {
    const target = coin ?? this.#coin
    const updates = await this.#info.userFunding({ user: this.#accountAddress, startTime: sinceMs })
    return updates
      .filter(u => u.delta.coin === target)
      .map(u => ({
        time: u.time,
        coin: u.delta.coin,
        usdc: Number(u.delta.usdc),
        szi: Number(u.delta.szi),
        fundingRate: Number(u.delta.fundingRate),
      }))
  }

  // ─── Quantization ───────────────────────────────────────────────

  quantizeBtcSize(sats: number, markPrice: number): number {
    if (this.#szDecimals == null) {
      throw new Error('Hyperliquid: quantizeBtcSize called before universe resolved (await getMarkPrice first)')
    }
    return quantizeBtc(sats, markPrice, this.#szDecimals)
  }

  // ─── Internals ──────────────────────────────────────────────────

  async #marketOrder(side: OrderSide, sizeBtc: number, reduceOnly: boolean): Promise<HyperliquidOrderResult> {
    const assetIdx = await this.#resolveAssetIndex(this.#coin)
    const szDecimals = this.#szDecimals!
    const sizeStr = sizeBtc.toFixed(szDecimals)
    if (Number(sizeStr) === 0) {
      throw new Error(`Hyperliquid: size ${sizeBtc} rounds to zero at ${szDecimals} decimals`)
    }

    const mark = await this.getMarkPrice()
    const slip = mark * (this.#slippageBps / 10_000)
    const aggressivePx = side === 'LONG' ? mark + slip : mark - slip
    const priceStr = formatPerpPrice(aggressivePx, szDecimals)

    const res = await this.#exchange.order({
      orders: [{
        a: assetIdx,
        b: side === 'LONG',
        p: priceStr,
        s: sizeStr,
        r: reduceOnly,
        t: { limit: { tif: 'Ioc' } },
      }],
      grouping: 'na',
    })

    const status = res.response.data.statuses[0]

    if (typeof status === 'string') {
      // "waitingForFill" or "waitingForTrigger" — IOC should never produce these, treat as no-fill
      throw new Error(`Hyperliquid order pending unexpectedly: ${status}`)
    }
    if ('error' in status) {
      throw new Error(`Hyperliquid order error: ${status.error}`)
    }
    if ('filled' in status) {
      return {
        orderId: status.filled.oid,
        status: 'filled',
        fillPrice: Number(status.filled.avgPx),
        size: Number(status.filled.totalSz),
        fee: 0,  // fee detail not in order response; query userFills if needed
        raw: status as unknown as Record<string, unknown>,
      }
    }
    if ('resting' in status) {
      // IOC resting means partial-fill-then-cancel; we treat as no-fill for safety
      return {
        orderId: status.resting.oid,
        status: 'resting',
        fillPrice: Number(priceStr),
        size: 0,
        fee: 0,
        raw: status as unknown as Record<string, unknown>,
      }
    }

    return {
      orderId: null,
      status: 'error',
      fillPrice: 0,
      size: 0,
      fee: 0,
      raw: status as unknown as Record<string, unknown>,
    }
  }

  async #resolveAssetIndex(coin: string): Promise<number> {
    if (this.#assetIndex != null && coin === this.#coin) return this.#assetIndex

    if (!this.#universePromise) {
      this.#universePromise = (async () => {
        const meta = await this.#info.meta()
        const idx = meta.universe.findIndex((u: UniverseEntry) => u.name === this.#coin)
        if (idx < 0) throw new Error(`Hyperliquid: coin ${this.#coin} not found in universe`)
        this.#assetIndex = idx
        this.#szDecimals = meta.universe[idx].szDecimals
      })()
    }
    await this.#universePromise
    return this.#assetIndex!
  }
}

// ─── Pure helpers (exported for tests) ───────────────────────────

export function quantizeBtc(sats: number, markPrice: number, szDecimals: number): number {
  if (sats <= 0) throw new Error(`quantizeBtc: sats must be positive (got ${sats})`)
  if (markPrice <= 0) throw new Error(`quantizeBtc: markPrice must be positive (got ${markPrice})`)
  if (szDecimals < 0 || szDecimals > 8) throw new Error(`quantizeBtc: szDecimals out of range (got ${szDecimals})`)

  // Work in integer sats to avoid float drift. 1 BTC = 1e8 sats; step (in sats) = 10^(8 - szDecimals).
  const stepSats = Math.pow(10, 8 - szDecimals)
  const quantizedSats = Math.ceil(sats / stepSats) * stepSats
  const rounded = Number((quantizedSats / 1e8).toFixed(szDecimals))

  if (rounded * markPrice < MIN_NOTIONAL_USD) {
    const minSatsForNotional = Math.ceil((MIN_NOTIONAL_USD / markPrice) * 1e8)
    const bumpedSats = Math.ceil(minSatsForNotional / stepSats) * stepSats
    return Number((bumpedSats / 1e8).toFixed(szDecimals))
  }
  return rounded
}

export function formatPerpPrice(price: number, szDecimals: number): string {
  // Hyperliquid: max 5 sig figs, max (6 - szDecimals) decimals for perps; integers always allowed.
  if (price <= 0) throw new Error(`formatPerpPrice: price must be positive (got ${price})`)
  const maxDecimals = Math.max(0, 6 - szDecimals)
  const sigFigs = 5

  const integerPart = Math.floor(price)
  if (integerPart.toString().length >= sigFigs) {
    return integerPart.toString()
  }
  const allowedDecimals = Math.min(maxDecimals, sigFigs - integerPart.toString().length)
  return price.toFixed(allowedDecimals)
}
