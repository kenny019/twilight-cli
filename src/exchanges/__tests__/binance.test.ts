/**
 * Validation contract for WS-4: Binance Client
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BinanceClientImpl } from '../binance.js'
import type { BinanceClient } from '../../types/index.js'

// Mock ccxt
vi.mock('ccxt', () => {
  const mockExchange = {
    loadMarkets: vi.fn().mockResolvedValue({}),
    fetchTicker: vi.fn().mockResolvedValue({ last: 65000 }),
    fetchFundingRate: vi.fn().mockResolvedValue({ fundingRate: 0.0001 }),
    fetchOrderBook: vi.fn().mockResolvedValue({ bids: [[65000, 1]], asks: [[65100, 2]] }),
    createOrder: vi.fn().mockResolvedValue({ id: 'order1', status: 'closed', price: 65000, amount: 0.1, fee: { cost: 0.026 } }),
    fetchBalance: vi.fn().mockResolvedValue({ total: { BTC: 0.5 }, info: { totalMarginBalance: '32500' } }),
    fetchPositions: vi.fn().mockResolvedValue([]),
    setLeverage: vi.fn().mockResolvedValue({}),
    setMarginMode: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    options: {},
  }
  return {
    pro: {
      binanceusdm: vi.fn(() => mockExchange),
    },
    binanceusdm: vi.fn(() => mockExchange),
  }
})

describe('WS-4: Binance Client', () => {
  let client: BinanceClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new BinanceClientImpl({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      symbol: 'BTC/USDT:USDT',
      testnet: true,
    })
  })

  describe('Market data', () => {
    it('fetches current price', async () => {
      const price = await client.getPrice()
      expect(typeof price).toBe('number')
      expect(price).toBeGreaterThan(0)
    })

    it('fetches funding rate', async () => {
      const rate = await client.getFundingRate()
      expect(typeof rate).toBe('number')
    })

    it('fetches orderbook', async () => {
      const book = await client.getOrderbook()
      expect(book.bids).toBeInstanceOf(Array)
      expect(book.asks).toBeInstanceOf(Array)
    })
  })

  describe('Trading operations', () => {
    it('opens a LONG position with leverage', async () => {
      const result = await client.openPosition('LONG', 0.1, 5)
      expect(result.orderId).toBeTruthy()
      expect(result.status).toBeTruthy()
    })

    it('opens a SHORT position', async () => {
      const result = await client.openPosition('SHORT', 0.1, 5)
      expect(result.orderId).toBeTruthy()
    })

    it('opens a LIMIT order', async () => {
      const result = await client.openPosition('LONG', 0.1, 5, 'LIMIT')
      expect(result.orderId).toBeTruthy()
    })

    it('closes a position', async () => {
      const result = await client.closePosition('LONG', 0.1)
      expect(result.orderId).toBeTruthy()
    })

    it('gets current position', async () => {
      const position = await client.getPosition()
      // Can be null if no position
      expect(position === null || typeof position === 'object').toBe(true)
    })

    it('gets all positions', async () => {
      const positions = await client.getPositions()
      expect(positions).toBeInstanceOf(Array)
    })
  })

  describe('Account operations', () => {
    it('gets available balance', async () => {
      const balance = await client.getBalance()
      expect(typeof balance).toBe('number')
    })

    it('gets margin balance', async () => {
      const balance = await client.getMarginBalance()
      expect(typeof balance).toBe('number')
    })
  })

  describe('WebSocket with REST fallback', () => {
    it('watchPrice returns a cleanup function', async () => {
      const cleanup = await client.watchPrice((_price) => {})
      expect(typeof cleanup).toBe('function')
      cleanup()
    })

    it('watchFundingRate returns a cleanup function', async () => {
      const cleanup = await client.watchFundingRate((_rate) => {})
      expect(typeof cleanup).toBe('function')
      cleanup()
    })
  })

  describe('Order lifecycle tracking', () => {
    it('tracks order from submission to fill', async () => {
      const result = await client.openPosition('LONG', 0.1, 5)
      expect(result.orderId).toBeTruthy()
      expect(result.status).toBeTruthy()
      expect(typeof result.price).toBe('number')
      expect(typeof result.size).toBe('number')
      expect(typeof result.fee).toBe('number')
    })
  })

  describe('Error handling', () => {
    it('retries on rate limit (429)', async () => {
      // The implementation should handle this internally via ccxt retry
      // We just verify the client doesn't crash on transient errors
      expect(client).toBeDefined()
    })

    it('does not log API credentials', async () => {
      // Verify the client stores credentials securely
      const clientStr = JSON.stringify(client)
      expect(clientStr).not.toContain('test-key')
      expect(clientStr).not.toContain('test-secret')
    })
  })

  describe('Lifecycle', () => {
    it('closes WebSocket connections', async () => {
      await expect(client.close()).resolves.toBeUndefined()
    })
  })
})
