/**
 * Validation contract for WS-3: Twilight Client
 * Tests define "done" — do not modify without orchestrator approval.
 *
 * Note: Tests mock execFile (NOT exec) — the safe child_process method
 * that prevents shell injection by passing args as an array.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TwilightClientImpl } from '../twilight.js'
import type { TwilightClient } from '../../types/index.js'

// Mock the execFile utility wrapper (safe, array-based argument passing)
vi.mock('../../utils/exec.js', () => ({
  execFileAsync: vi.fn(),
}))

import { execFileAsync } from '../../utils/exec.js'

const mockExecFileAsync = vi.mocked(execFileAsync)

function mockSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' })
}

function mockError(stderr: string) {
  mockExecFileAsync.mockRejectedValue(new Error(stderr))
}

describe('WS-3: Twilight Client', () => {
  let client: TwilightClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new TwilightClientImpl({
      binaryPath: './bin/relayer-cli',
      walletId: 'test-wallet',
      password: 'test-pass',
    })
  })

  describe('Market data (no wallet required)', () => {
    it('fetches current price via relayer-cli market price --json', async () => {
      mockSuccess(JSON.stringify({ price: 65000.50 }))
      const price = await client.marketPrice()
      expect(price).toBe(65000.50)
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['--json', 'market', 'price']),
        expect.any(Object),
      )
    })

    it('fetches funding rate', async () => {
      mockSuccess(JSON.stringify({ funding_rate: 0.0003 }))
      const rate = await client.fundingRate()
      expect(typeof rate).toBe('number')
    })

    it('fetches fee rates', async () => {
      mockSuccess(JSON.stringify({
        market_fill: 0.04,
        limit_fill: 0.02,
        market_settle: 0.04,
        limit_settle: 0.02,
      }))
      const fees = await client.feeRate()
      expect(fees).toHaveProperty('marketFill')
      expect(fees).toHaveProperty('limitFill')
      expect(fees).toHaveProperty('marketSettle')
      expect(fees).toHaveProperty('limitSettle')
    })

    it('fetches orderbook', async () => {
      mockSuccess(JSON.stringify({ bids: [[65000, 1]], asks: [[65100, 2]] }))
      const book = await client.orderbook()
      expect(book.bids).toBeInstanceOf(Array)
      expect(book.asks).toBeInstanceOf(Array)
    })

    it('fetches lend pool info', async () => {
      mockSuccess(JSON.stringify({ total_deposits: 500000, share_value: 1.05, apy: 15.5 }))
      const pool = await client.lendPool()
      expect(pool).toHaveProperty('totalDeposits')
      expect(pool).toHaveProperty('shareValue')
      expect(pool).toHaveProperty('apy')
    })

    it('fetches last day APY', async () => {
      mockSuccess(JSON.stringify({ apy: 18.2 }))
      const apy = await client.lastDayApy()
      expect(typeof apy).toBe('number')
    })
  })

  describe('Wallet operations', () => {
    it('fetches wallet balance from plain text', async () => {
      mockSuccess('Wallet Balance\n  Address:  twilight1abc\n  NYKS:     1000\n  SATS:     50000\n')
      const balance = await client.walletBalance()
      expect(balance).toEqual({ nyks: 1000, sats: 50000 })
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.not.arrayContaining(['--json']),
        expect.any(Object),
      )
    })

    it('lists wallet accounts from plain-text table', async () => {
      mockSuccess(
        'INDEX    BALANCE      ON-CHAIN   IO-TYPE    ACCOUNT\n' +
        '------------------------------------------------------------------------------------------\n' +
        '0        50000        true       Coin       abc123\n' +
        '1        30000        true       Memo       def456\n',
      )
      const accounts = await client.walletAccounts()
      expect(accounts).toHaveLength(2)
      expect(accounts[0]).toEqual({ index: 0, balance: 50000, onChain: true, ioType: 'Coin' })
      expect(accounts[1]).toEqual({ index: 1, balance: 30000, onChain: true, ioType: 'Memo' })
    })

    it('returns empty array when no accounts found', async () => {
      mockSuccess('No ZkOS accounts found\n')
      const accounts = await client.walletAccounts()
      expect(accounts).toEqual([])
    })
  })

  describe('ZkAccount operations', () => {
    const fundOutput = 'Funding 10000 sats to new ZkOS trading account...\nFunding successful\n  TX hash: ABC123\n  TX code: 0\n  Account index: 2\n'

    it('funds a new ZkOS account from plain text', async () => {
      mockSuccess(fundOutput)
      const result = await client.fund(10000)
      expect(result).toEqual({ requestId: 'ABC123', accountIndex: 2, status: 'success' })
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.not.arrayContaining(['--json']),
        expect.any(Object),
      )
    })

    it('withdraws from a ZkOS account', async () => {
      mockSuccess('Withdrawing...\n  TX hash: DEF456\n  TX code: 0\n  Account index: 0\n')
      const result = await client.withdraw(0)
      expect(result.requestId).toBe('DEF456')
      expect(result.status).toBe('success')
    })

    it('transfers (rotates) an account', async () => {
      mockSuccess('Transferring...\n  TX hash: GHI789\n  TX code: 0\n  Account index: 3\n')
      const result = await client.transfer(0)
      expect(result.requestId).toBe('GHI789')
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['zkaccount', 'transfer', '--account-index', '0']),
        expect.any(Object),
      )
    })

    it('splits an account into multiple', async () => {
      mockSuccess('Splitting...\n  TX hash: JKL000\n  TX code: 0\n  Account index: 0\n')
      const result = await client.split(0, [2000, 3000, 5000])
      expect(result.requestId).toBe('JKL000')
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['zkaccount', 'split', '--from', '0', '--balances', '2000,3000,5000']),
        expect.any(Object),
      )
    })
  })

  describe('Order operations', () => {
    it('opens a LONG trade with leverage', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_OPEN', account_index: 0, status: 'FILLED' }))
      const result = await client.openTrade(0, 'LONG', 65000, 5)
      expect(result.requestId).toBeTruthy()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['order', 'open-trade', '--account-index', '0', '--side', 'LONG', '--entry-price', '65000', '--leverage', '5']),
        expect.any(Object),
      )
    })

    it('opens a LIMIT order', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_LIM', account_index: 1, status: 'PENDING' }))
      const result = await client.openTrade(1, 'SHORT', 70000, 5, 'LIMIT')
      expect(result.requestId).toBeTruthy()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['--order-type', 'LIMIT']),
        expect.any(Object),
      )
    })

    it('closes a trade and auto-rotates account', async () => {
      // First call: close-trade (JSON). Second call: zkaccount transfer (plain text)
      let callCount = 0
      mockExecFileAsync.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return { stdout: JSON.stringify({ request_id: 'REQ_CLOSE', account_index: 0, status: 'SETTLED' }), stderr: '' }
        } else {
          return { stdout: 'Transferring...\n  TX hash: REQ_ROT\n  TX code: 0\n  Account index: 4\n', stderr: '' }
        }
      })

      const result = await client.closeTrade(0)
      expect(result.requestId).toBeTruthy()
      // Verify account rotation was called after close
      expect(callCount).toBe(2)
    })

    it('closes with stop-loss and take-profit', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_SLTP', account_index: 0, status: 'PENDING' }))
      await client.closeTrade(0, { stopLoss: 60000, takeProfit: 75000 })
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['--stop-loss', '60000', '--take-profit', '75000']),
        expect.any(Object),
      )
    })

    it('cancels a pending trade', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_CAN', account_index: 0, status: 'CANCELLED' }))
      const result = await client.cancelTrade(0)
      expect(result.requestId).toBeTruthy()
    })

    it('queries trade status', async () => {
      mockSuccess(JSON.stringify({ uuid: 'ORDER123', order_status: 'FILLED', side: 'LONG' }))
      const result = await client.queryTrade(0)
      expect(result.orderStatus).toBe('FILLED')
      expect(result.raw).toHaveProperty('uuid')
    })

    it('unlocks a settled SLTP trade', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_UNL', account_index: 0, status: 'success' }))
      const result = await client.unlockTrade(0)
      expect(result.requestId).toBeTruthy()
    })
  })

  describe('Lending operations', () => {
    it('opens a lend order via order open-lend', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_LEND', account_index: 0, status: 'success' }))
      const result = await client.openLend(0)
      expect(result.requestId).toBeTruthy()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['order', 'open-lend']),
        expect.any(Object),
      )
    })

    it('closes a lend order via order close-lend', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_CLEND', account_index: 0, status: 'success' }))
      const result = await client.closeLend(0)
      expect(result.requestId).toBeTruthy()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['order', 'close-lend']),
        expect.any(Object),
      )
    })

    it('queries lend status via order query-lend', async () => {
      mockSuccess(JSON.stringify({ uuid: 'LEND123', status: 'ACTIVE' }))
      const result = await client.queryLend(0)
      expect(result).toHaveProperty('uuid')
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['order', 'query-lend']),
        expect.any(Object),
      )
    })
  })

  describe('Error handling', () => {
    it('wraps relayer-cli errors in typed errors', async () => {
      mockError('Error: account not found')
      await expect(client.marketPrice()).rejects.toThrow()
    })
  })

  describe('Configuration', () => {
    it('uses configurable binary path', () => {
      const customClient = new TwilightClientImpl({
        binaryPath: '/custom/path/relayer-cli',
        walletId: 'w',
        password: 'p',
      })
      expect(customClient).toBeDefined()
    })

    it('passes wallet-id and password flags', async () => {
      mockSuccess('Wallet Balance\n  NYKS:     100\n  SATS:     5000\n')
      await client.walletBalance()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['--wallet-id', 'test-wallet', '--password', 'test-pass']),
        expect.any(Object),
      )
    })
  })
})
