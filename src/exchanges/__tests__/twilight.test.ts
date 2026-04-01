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
    it('fetches wallet balance', async () => {
      mockSuccess(JSON.stringify({ nyks: 1000, sats: 50000 }))
      const balance = await client.walletBalance()
      expect(balance).toHaveProperty('nyks')
      expect(balance).toHaveProperty('sats')
    })

    it('lists wallet accounts', async () => {
      mockSuccess(JSON.stringify([
        { index: 0, balance: 50000, on_chain: true, io_type: 'Coin' },
        { index: 1, balance: 30000, on_chain: true, io_type: 'Memo' },
      ]))
      const accounts = await client.walletAccounts()
      expect(accounts).toHaveLength(2)
      expect(accounts[0]).toHaveProperty('index')
      expect(accounts[0]).toHaveProperty('balance')
    })
  })

  describe('ZkAccount operations', () => {
    it('funds a new ZkOS account', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ123', account_index: 2, status: 'success' }))
      const result = await client.fund(10000)
      expect(result.requestId).toBeTruthy()
      expect(result.status).toBe('success')
    })

    it('withdraws from a ZkOS account', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ456', account_index: 0, status: 'success' }))
      const result = await client.withdraw(0)
      expect(result.requestId).toBeTruthy()
    })

    it('transfers (rotates) an account', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ789', account_index: 3, status: 'success' }))
      const result = await client.transfer(0)
      expect(result.requestId).toBeTruthy()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['zkaccount', 'transfer', '--from', '0']),
        expect.any(Object),
      )
    })

    it('splits an account into multiple', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ000', account_index: 0, status: 'success' }))
      const result = await client.split(0, [2000, 3000, 5000])
      expect(result.requestId).toBeTruthy()
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
      // First call: close-trade. Second call: zkaccount transfer (rotation)
      let callCount = 0
      mockExecFileAsync.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return { stdout: JSON.stringify({ request_id: 'REQ_CLOSE', account_index: 0, status: 'SETTLED' }), stderr: '' }
        } else {
          return { stdout: JSON.stringify({ request_id: 'REQ_ROT', account_index: 4, status: 'success' }), stderr: '' }
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
      mockSuccess(JSON.stringify({ uuid: 'ORDER123', status: 'FILLED', side: 'LONG' }))
      const result = await client.queryTrade(0)
      expect(result).toHaveProperty('uuid')
    })

    it('unlocks a settled SLTP trade', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_UNL', account_index: 0, status: 'success' }))
      const result = await client.unlockTrade(0)
      expect(result.requestId).toBeTruthy()
    })
  })

  describe('Lending operations', () => {
    it('opens a lend order', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_LEND', account_index: 0, status: 'success' }))
      const result = await client.openLend(0)
      expect(result.requestId).toBeTruthy()
    })

    it('closes a lend order', async () => {
      mockSuccess(JSON.stringify({ request_id: 'REQ_CLEND', account_index: 0, status: 'success' }))
      const result = await client.closeLend(0)
      expect(result.requestId).toBeTruthy()
    })

    it('queries lend status', async () => {
      mockSuccess(JSON.stringify({ uuid: 'LEND123', status: 'ACTIVE' }))
      const result = await client.queryLend(0)
      expect(result).toHaveProperty('uuid')
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
      mockSuccess(JSON.stringify({ nyks: 100, sats: 5000 }))
      await client.walletBalance()
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        './bin/relayer-cli',
        expect.arrayContaining(['--wallet-id', 'test-wallet', '--password', 'test-pass']),
        expect.any(Object),
      )
    })
  })
})
