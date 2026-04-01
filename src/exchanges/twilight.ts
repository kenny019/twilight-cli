import { execFileAsync } from '../utils/exec.js'
import type {
  TwilightClient,
  TwilightAccount,
  TwilightTradeResult,
  TwilightLendPool,
  TwilightMarketData,
  OrderSide,
  OrderType,
} from '../types/index.js'

export interface TwilightClientConfig {
  binaryPath: string
  walletId: string
  password: string
}

export class TwilightClientImpl implements TwilightClient {
  private readonly bin: string
  private readonly walletId: string
  private readonly password: string

  constructor(config: TwilightClientConfig) {
    this.bin = config.binaryPath
    this.walletId = config.walletId
    this.password = config.password
  }

  // ─── Private helpers ────────────────────────────────────────────

  private walletFlags(): string[] {
    return ['--wallet-id', this.walletId, '--password', this.password]
  }

  private async run(args: string[]): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.bin, args, {})
      return JSON.parse(stdout)
    } catch (err) {
      throw new Error(`relayer-cli failed: ${(err as Error).message}`, { cause: err })
    }
  }

  private mapTradeResult(raw: Record<string, unknown>): TwilightTradeResult {
    return {
      requestId: raw['request_id'] as string,
      accountIndex: raw['account_index'] as number,
      status: raw['status'] as string,
    }
  }

  // ─── Market data (no wallet required) ───────────────────────────

  async marketPrice(): Promise<number> {
    const raw = await this.run(['--json', 'market', 'price']) as { price: number }
    return raw.price
  }

  async fundingRate(): Promise<number> {
    const raw = await this.run(['--json', 'market', 'funding-rate']) as { funding_rate: number }
    return raw.funding_rate
  }

  async feeRate(): Promise<TwilightMarketData['feeRate']> {
    const raw = await this.run(['--json', 'market', 'fee-rate']) as {
      market_fill: number
      limit_fill: number
      market_settle: number
      limit_settle: number
    }
    return {
      marketFill: raw.market_fill,
      limitFill: raw.limit_fill,
      marketSettle: raw.market_settle,
      limitSettle: raw.limit_settle,
    }
  }

  async orderbook(): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }> {
    const raw = await this.run(['--json', 'market', 'orderbook']) as {
      bids: Array<[number, number]>
      asks: Array<[number, number]>
    }
    return { bids: raw.bids, asks: raw.asks }
  }

  async lendPool(): Promise<TwilightLendPool> {
    const raw = await this.run(['--json', 'market', 'lend-pool']) as {
      total_deposits: number
      share_value: number
      apy: number
    }
    return {
      totalDeposits: raw.total_deposits,
      shareValue: raw.share_value,
      apy: raw.apy,
    }
  }

  async lastDayApy(): Promise<number> {
    const raw = await this.run(['--json', 'market', 'last-day-apy']) as { apy: number }
    return raw.apy
  }

  async marketStats(): Promise<Record<string, unknown>> {
    return this.run(['--json', 'market', 'stats']) as Promise<Record<string, unknown>>
  }

  // ─── Wallet operations ───────────────────────────────────────────

  async walletBalance(): Promise<{ nyks: number; sats: number }> {
    const raw = await this.run([...this.walletFlags(), '--json', 'wallet', 'balance']) as {
      nyks: number
      sats: number
    }
    return { nyks: raw.nyks, sats: raw.sats }
  }

  async walletAccounts(): Promise<TwilightAccount[]> {
    const raw = await this.run([...this.walletFlags(), '--json', 'wallet', 'accounts']) as Array<{
      index: number
      balance: number
      on_chain: boolean
      io_type: string
    }>
    return raw.map(a => ({
      index: a.index,
      balance: a.balance,
      onChain: a.on_chain,
      ioType: a.io_type,
    }))
  }

  // ─── ZkAccount operations ────────────────────────────────────────

  async fund(amountSats: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'zkaccount', 'fund', '--amount', String(amountSats),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async withdraw(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'zkaccount', 'withdraw', '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async transfer(fromAccountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'zkaccount', 'transfer', '--from', String(fromAccountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async split(fromAccountIndex: number, balancesSats: number[]): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(),
      '--json', 'zkaccount', 'split',
      '--from', String(fromAccountIndex),
      '--balances', balancesSats.join(','),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  // ─── Order operations ────────────────────────────────────────────

  async openTrade(
    accountIndex: number,
    side: OrderSide,
    entryPrice: number,
    leverage: number,
    orderType: OrderType = 'MARKET',
  ): Promise<TwilightTradeResult> {
    const args = [
      ...this.walletFlags(),
      '--json', 'order', 'open-trade',
      '--account-index', String(accountIndex),
      '--side', side,
      '--entry-price', String(entryPrice),
      '--leverage', String(leverage),
      '--order-type', orderType,
    ]
    const raw = await this.run(args) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async closeTrade(
    accountIndex: number,
    options?: { stopLoss?: number; takeProfit?: number },
  ): Promise<TwilightTradeResult> {
    const hasSltp = options?.stopLoss !== undefined || options?.takeProfit !== undefined

    const args = [
      ...this.walletFlags(),
      '--json', 'order', 'close-trade',
      '--account-index', String(accountIndex),
    ]

    if (hasSltp) {
      if (options?.stopLoss !== undefined) {
        args.push('--stop-loss', String(options.stopLoss))
      }
      if (options?.takeProfit !== undefined) {
        args.push('--take-profit', String(options.takeProfit))
      }
    }

    const raw = await this.run(args) as Record<string, unknown>
    const result = this.mapTradeResult(raw)

    // Auto-rotate the account after a plain close; SLTP closes leave the
    // account locked until settlement so rotation must wait.
    if (!hasSltp) {
      await this.transfer(accountIndex)
    }

    return result
  }

  async cancelTrade(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'order', 'cancel-trade',
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async queryTrade(accountIndex: number): Promise<Record<string, unknown>> {
    return this.run([
      ...this.walletFlags(), '--json', 'order', 'query-trade',
      '--account-index', String(accountIndex),
    ]) as Promise<Record<string, unknown>>
  }

  async unlockTrade(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'order', 'unlock-trade',
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  // ─── Lending operations ──────────────────────────────────────────

  async openLend(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'lend', 'open',
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async closeLend(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      ...this.walletFlags(), '--json', 'lend', 'close',
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async queryLend(accountIndex: number): Promise<Record<string, unknown>> {
    return this.run([
      ...this.walletFlags(), '--json', 'lend', 'query',
      '--account-index', String(accountIndex),
    ]) as Promise<Record<string, unknown>>
  }
}
