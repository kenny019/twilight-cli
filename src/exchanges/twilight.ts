import { execFileAsync } from '../utils/exec.js'
import type {
  TwilightClient,
  TwilightAccount,
  TwilightTradeResult,
  TwilightTradeQuery,
  TwilightOrderStatus,
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

  private async invoke(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.bin, args, {})
      return stdout
    } catch (err) {
      throw new Error(`relayer-cli failed: ${(err as Error).message}`, { cause: err })
    }
  }

  private async run(args: string[]): Promise<unknown> {
    return JSON.parse(await this.invoke(args))
  }

  private parseTradeResult(stdout: string): TwilightTradeResult {
    const txHash = stdout.match(/TX hash:\s*(\S+)/)?.[1]
    const accountIndexStr = stdout.match(/Account index:\s*(\d+)/)?.[1]
    if (!txHash || !accountIndexStr) {
      throw new Error(`Failed to parse relayer-cli output: ${stdout.slice(0, 200)}`)
    }
    return { requestId: txHash, accountIndex: parseInt(accountIndexStr, 10), status: 'success' }
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
    const stdout = await this.invoke(['wallet', 'balance', ...this.walletFlags()])
    const nyks = parseInt(stdout.match(/NYKS:\s+(\d+)/)?.[1] ?? '0', 10)
    const sats = parseInt(stdout.match(/SATS:\s+(\d+)/)?.[1] ?? '0', 10)
    return { nyks, sats }
  }

  async walletAccounts(): Promise<TwilightAccount[]> {
    const stdout = await this.invoke(['wallet', 'accounts', ...this.walletFlags()])
    if (stdout.includes('No ZkOS accounts found')) return []

    const accounts: TwilightAccount[] = []
    const lines = stdout.split('\n')
    for (const line of lines) {
      // Match table rows: INDEX  BALANCE  ON-CHAIN  IO-TYPE  ACCOUNT
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(true|false)\s+(\S+)\s+(\S+)/)
      if (match) {
        accounts.push({
          index: parseInt(match[1], 10),
          balance: parseInt(match[2], 10),
          onChain: match[3] === 'true',
          ioType: match[4],
        })
      }
    }
    return accounts
  }

  async syncNonce(): Promise<void> {
    await this.invoke(['wallet', 'sync-nonce', ...this.walletFlags()])
  }

  // ─── ZkAccount operations ────────────────────────────────────────

  async fund(amountSats: number): Promise<TwilightTradeResult> {
    const stdout = await this.invoke([
      'zkaccount', 'fund', ...this.walletFlags(), '--amount', String(amountSats),
    ])
    return this.parseTradeResult(stdout)
  }

  async withdraw(accountIndex: number): Promise<TwilightTradeResult> {
    const stdout = await this.invoke([
      'zkaccount', 'withdraw', ...this.walletFlags(), '--account-index', String(accountIndex),
    ])
    return this.parseTradeResult(stdout)
  }

  async transfer(fromAccountIndex: number): Promise<TwilightTradeResult> {
    const stdout = await this.invoke([
      'zkaccount', 'transfer', ...this.walletFlags(), '--account-index', String(fromAccountIndex),
    ])
    // v0.1.2 prints "Transfer successful\n  New account index: N" — no TX hash header.
    if (stdout.includes('Transfer successful')) {
      const newIdx = parseInt(stdout.match(/New account index:\s*(\d+)/)?.[1] ?? '-1', 10)
      return { requestId: `transfer-${fromAccountIndex}`, accountIndex: newIdx, status: 'success' }
    }
    return this.parseTradeResult(stdout)
  }

  async split(fromAccountIndex: number, balancesSats: number[]): Promise<TwilightTradeResult> {
    const stdout = await this.invoke([
      'zkaccount', 'split', ...this.walletFlags(),
      '--from', String(fromAccountIndex),
      '--balances', balancesSats.join(','),
    ])
    // Split prints per-child summary, not the standard "TX hash" header.
    if (stdout.includes('Split successful')) {
      return { requestId: `split-${fromAccountIndex}`, accountIndex: fromAccountIndex, status: 'success' }
    }
    return this.parseTradeResult(stdout)
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
      '--json', 'order', 'open-trade', ...this.walletFlags(),
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
    options?: { stopLoss?: number; takeProfit?: number; skipRotation?: boolean },
  ): Promise<TwilightTradeResult> {
    const hasSltp = options?.stopLoss !== undefined || options?.takeProfit !== undefined

    const args = [
      '--json', 'order', 'close-trade', ...this.walletFlags(),
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

    // Auto-rotate after a plain close. Skipped for SLTP (account stays
    // locked until settlement) and for callers that manage rotation
    // themselves (e.g. volume-farm, which waits for SETTLED + unlock
    // before transferring).
    if (!hasSltp && !options?.skipRotation) {
      await this.transfer(accountIndex)
    }

    return result
  }

  // Polls queryTrade until orderStatus matches target (or a terminal failure
  // status appears). Used by strategies that need explicit chain settlement
  // confirmation between open → close → unlock → transfer steps.
  async waitForOrderStatus(
    accountIndex: number,
    target: 'FILLED' | 'SETTLED',
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<TwilightOrderStatus> {
    const timeoutMs = options?.timeoutMs ?? 30_000
    const interval = options?.pollIntervalMs ?? 1_000
    const deadline = Date.now() + timeoutMs
    let last: TwilightOrderStatus = 'UNKNOWN'

    while (Date.now() < deadline) {
      try {
        const q = await this.queryTrade(accountIndex)
        last = q.orderStatus
        if (last === target) return last
        if (last === 'CANCELLED' || last === 'LIQUIDATED') {
          throw new Error(`waitForOrderStatus: terminal status ${last} (wanted ${target})`)
        }
      } catch (err) {
        // queryTrade can transiently fail while chain catches up; keep polling
        // until the deadline. Re-throw on the last try via the post-loop throw.
        if ((err as Error).message.startsWith('waitForOrderStatus:')) throw err
      }
      await new Promise(r => setTimeout(r, interval))
    }
    throw new Error(`waitForOrderStatus: timeout after ${timeoutMs}ms (last=${last}, wanted=${target})`)
  }

  async cancelTrade(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      '--json', 'order', 'cancel-trade', ...this.walletFlags(),
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async queryTrade(accountIndex: number): Promise<TwilightTradeQuery> {
    const raw = await this.run([
      '--json', 'order', 'query-trade', ...this.walletFlags(),
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return { orderStatus: parseOrderStatus(raw), raw }
  }

  async unlockTrade(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      '--json', 'order', 'unlock-close-order', ...this.walletFlags(),
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  // ─── Lending operations ──────────────────────────────────────────

  async openLend(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      '--json', 'order', 'open-lend', ...this.walletFlags(),
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async closeLend(accountIndex: number): Promise<TwilightTradeResult> {
    const raw = await this.run([
      '--json', 'order', 'close-lend', ...this.walletFlags(),
      '--account-index', String(accountIndex),
    ]) as Record<string, unknown>
    return this.mapTradeResult(raw)
  }

  async queryLend(accountIndex: number): Promise<Record<string, unknown>> {
    return this.run([
      '--json', 'order', 'query-lend', ...this.walletFlags(),
      '--account-index', String(accountIndex),
    ]) as Promise<Record<string, unknown>>
  }
}

const VALID_ORDER_STATUSES: TwilightOrderStatus[] = ['PENDING', 'FILLED', 'SETTLED', 'CANCELLED', 'LIQUIDATED']

function parseOrderStatus(raw: Record<string, unknown>): TwilightOrderStatus {
  const candidate = (raw['order_status'] ?? raw['status']) as string | undefined
  if (typeof candidate !== 'string') return 'UNKNOWN'
  const upper = candidate.toUpperCase() as TwilightOrderStatus
  return VALID_ORDER_STATUSES.includes(upper) ? upper : 'UNKNOWN'
}
