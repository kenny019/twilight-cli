import { describe, it, expect, beforeEach } from 'vitest'
import { SandboxClock } from '../clock.js'
import { MockTwilightClient } from '../mock-twilight.js'
import { MockBinanceClient } from '../mock-binance.js'
import type { MarketDataPoint } from '../../types/agent.js'

function makeData(overrides: Partial<MarketDataPoint>[] = []): MarketDataPoint[] {
  const base: MarketDataPoint[] = [
    { timestamp: '2024-01-01T00:00:00Z', price: 40000, twilightFundingRate: 0.01, binanceFundingRate: 0.005, lendingApy: 5 },
    { timestamp: '2024-01-01T01:00:00Z', price: 40500, twilightFundingRate: 0.012, binanceFundingRate: 0.006, lendingApy: 5.2 },
    { timestamp: '2024-01-01T02:00:00Z', price: 39500, twilightFundingRate: 0.008, binanceFundingRate: 0.004, lendingApy: 4.8 },
    { timestamp: '2024-01-01T03:00:00Z', price: 41000, twilightFundingRate: 0.015, binanceFundingRate: 0.007, lendingApy: 5.5 },
    { timestamp: '2024-01-01T04:00:00Z', price: 40200, twilightFundingRate: 0.011, binanceFundingRate: 0.0055, lendingApy: 5.1 },
  ]
  for (let i = 0; i < overrides.length && i < base.length; i++) {
    Object.assign(base[i], overrides[i])
  }
  return base
}

// ─── SandboxClock ───────────────────────────────────────────────

describe('SandboxClock', () => {
  it('throws on empty data', () => {
    expect(() => new SandboxClock([])).toThrow('at least one data point')
  })

  it('starts at index 0 and returns the first data point', () => {
    const data = makeData()
    const clock = new SandboxClock(data)
    expect(clock.current().price).toBe(40000)
    expect(clock.timestamp()).toBe('2024-01-01T00:00:00Z')
  })

  it('advances through data and reports exhaustion', () => {
    const data = makeData()
    const clock = new SandboxClock(data)

    expect(clock.exhausted).toBe(false)
    expect(clock.advance()).toBe(true) // -> index 1
    expect(clock.current().price).toBe(40500)
    expect(clock.advance()).toBe(true) // -> index 2
    expect(clock.advance()).toBe(true) // -> index 3
    expect(clock.advance()).toBe(true) // -> index 4 (last)
    expect(clock.exhausted).toBe(true)
    expect(clock.advance()).toBe(false) // can't go further
  })

  it('reports progress correctly', () => {
    const data = makeData()
    const clock = new SandboxClock(data)
    expect(clock.progress()).toEqual({ current: 1, total: 5, pct: 20 })
    clock.advance()
    clock.advance()
    expect(clock.progress()).toEqual({ current: 3, total: 5, pct: 60 })
  })

  it('peek looks ahead without advancing', () => {
    const data = makeData()
    const clock = new SandboxClock(data)
    expect(clock.peek(0)?.price).toBe(40000)
    expect(clock.peek(2)?.price).toBe(39500)
    expect(clock.peek(10)).toBeUndefined()
    // Index should still be 0
    expect(clock.current().price).toBe(40000)
  })

  it('reset returns to index 0', () => {
    const data = makeData()
    const clock = new SandboxClock(data)
    clock.advance()
    clock.advance()
    expect(clock.current().price).toBe(39500)
    clock.reset()
    expect(clock.current().price).toBe(40000)
    expect(clock.exhausted).toBe(false)
  })
})

// ─── MockTwilightClient ─────────────────────────────────────────

describe('MockTwilightClient', () => {
  let clock: SandboxClock
  let tw: MockTwilightClient

  beforeEach(() => {
    clock = new SandboxClock(makeData())
    tw = new MockTwilightClient(clock, 1_000_000)
  })

  describe('market data', () => {
    it('returns clock price', async () => {
      expect(await tw.marketPrice()).toBe(40000)
      clock.advance()
      expect(await tw.marketPrice()).toBe(40500)
    })

    it('returns clock funding rate', async () => {
      expect(await tw.fundingRate()).toBe(0.01)
    })

    it('returns fee rate', async () => {
      const fees = await tw.feeRate()
      expect(fees.marketFill).toBeGreaterThan(0)
      expect(fees.limitFill).toBeGreaterThan(0)
    })

    it('returns lend pool', async () => {
      const pool = await tw.lendPool()
      expect(pool.apy).toBe(5)
    })

    it('returns lastDayApy from clock', async () => {
      expect(await tw.lastDayApy()).toBe(5)
    })

    it('returns orderbook with 5 levels', async () => {
      const ob = await tw.orderbook()
      expect(ob.bids).toHaveLength(5)
      expect(ob.asks).toHaveLength(5)
      // Bids below price, asks above
      expect(ob.bids[0][0]).toBeLessThan(40000)
      expect(ob.asks[0][0]).toBeGreaterThan(40000)
    })
  })

  describe('fund + withdraw', () => {
    it('fund deducts wallet and creates account', async () => {
      const result = await tw.fund(500_000)
      expect(result.status).toBe('success')
      const acct = tw.getAccount(result.accountIndex)
      expect(acct).toBeDefined()
      expect(acct!.balance).toBe(500_000)
      expect(acct!.ioType).toBe('Coin')

      const wallet = await tw.walletBalance()
      expect(wallet.sats).toBe(500_000)
    })

    it('fund throws on insufficient balance', async () => {
      await expect(tw.fund(2_000_000)).rejects.toThrow('Insufficient')
    })

    it('withdraw adds back to wallet and removes account', async () => {
      const { accountIndex } = await tw.fund(300_000)
      await tw.withdraw(accountIndex)

      expect(tw.getAccount(accountIndex)).toBeUndefined()
      const wallet = await tw.walletBalance()
      expect(wallet.sats).toBe(1_000_000)
    })
  })

  describe('transfer + split', () => {
    it('transfer creates new account with same balance', async () => {
      const { accountIndex: oldIdx } = await tw.fund(200_000)
      const result = await tw.transfer(oldIdx)
      const newIdx = result.accountIndex

      expect(tw.getAccount(oldIdx)).toBeUndefined()
      expect(tw.getAccount(newIdx)!.balance).toBe(200_000)
    })

    it('split divides balance into multiple accounts', async () => {
      const { accountIndex } = await tw.fund(500_000)
      const result = await tw.split(accountIndex, [200_000, 300_000])

      expect(tw.getAccount(accountIndex)).toBeUndefined()
      const firstIdx = result.accountIndex
      expect(tw.getAccount(firstIdx)!.balance).toBe(200_000)
      expect(tw.getAccount(firstIdx + 1)!.balance).toBe(300_000)
    })

    it('split throws if amounts exceed balance', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await expect(tw.split(accountIndex, [60_000, 60_000])).rejects.toThrow('exceed')
    })
  })

  describe('openTrade + closeTrade', () => {
    it('LONG profit: price goes up', async () => {
      const { accountIndex } = await tw.fund(100_000)
      // Price = 40000, open LONG 2x
      await tw.openTrade(accountIndex, 'LONG', 40000, 2)

      const acct = tw.getAccount(accountIndex)!
      expect(acct.ioType).toBe('Order')
      expect(acct.position).toBeDefined()
      expect(acct.position!.side).toBe('LONG')

      // Advance to price 40500 (+1.25%)
      clock.advance()
      await tw.closeTrade(accountIndex)

      const closed = tw.getAccount(accountIndex)!
      expect(closed.ioType).toBe('Coin')
      expect(closed.position).toBeNull()
      // PnL = (40500 - 40000) / 40000 * 100000 * 2 = 2500
      expect(closed.balance).toBeCloseTo(102500)
    })

    it('LONG loss: price goes down', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await tw.openTrade(accountIndex, 'LONG', 40000, 2)

      // Advance to price 39500 (-1.25%)
      clock.advance()
      clock.advance()
      await tw.closeTrade(accountIndex)

      const closed = tw.getAccount(accountIndex)!
      // PnL = (39500 - 40000) / 40000 * 100000 * 2 = -2500
      expect(closed.balance).toBeCloseTo(97500)
    })

    it('SHORT profit: price goes down', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await tw.openTrade(accountIndex, 'SHORT', 40000, 2)

      // Advance to price 39500
      clock.advance()
      clock.advance()
      await tw.closeTrade(accountIndex)

      const closed = tw.getAccount(accountIndex)!
      // PnL = (40000 - 39500) / 40000 * 100000 * 2 = 2500
      expect(closed.balance).toBeCloseTo(102500)
    })

    it('throws when opening trade on non-Coin account', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await tw.openTrade(accountIndex, 'LONG', 40000, 1)
      await expect(tw.openTrade(accountIndex, 'LONG', 40000, 1)).rejects.toThrow('not a Coin')
    })

    it('throws when closing with no position', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await expect(tw.closeTrade(accountIndex)).rejects.toThrow('no open position')
    })
  })

  describe('openLend + closeLend', () => {
    it('changes ioType to Lend and back', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await tw.openLend(accountIndex)
      expect(tw.getAccount(accountIndex)!.ioType).toBe('Lend')

      await tw.closeLend(accountIndex)
      expect(tw.getAccount(accountIndex)!.ioType).toBe('Coin')
    })

    it('closeLend adds yield', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await tw.openLend(accountIndex)
      await tw.closeLend(accountIndex)

      // APY = 5, daily yield = 100000 * 5/100/365 ≈ 13.7
      expect(tw.getAccount(accountIndex)!.balance).toBeGreaterThan(100_000)
    })

    it('throws when opening lend on non-Coin account', async () => {
      const { accountIndex } = await tw.fund(100_000)
      await tw.openLend(accountIndex)
      await expect(tw.openLend(accountIndex)).rejects.toThrow('not a Coin')
    })
  })

  describe('walletAccounts + getTotalBalance', () => {
    it('walletAccounts returns all accounts', async () => {
      await tw.fund(200_000)
      await tw.fund(300_000)
      const accounts = await tw.walletAccounts()
      expect(accounts).toHaveLength(2)
    })

    it('getTotalBalance sums wallet + accounts', async () => {
      await tw.fund(400_000)
      expect(tw.getTotalBalance()).toBe(1_000_000)
    })
  })
})

// ─── MockBinanceClient ──────────────────────────────────────────

describe('MockBinanceClient', () => {
  let clock: SandboxClock
  let bn: MockBinanceClient

  beforeEach(() => {
    clock = new SandboxClock(makeData())
    bn = new MockBinanceClient(clock, 0.5)
  })

  it('getPrice returns clock price', async () => {
    expect(await bn.getPrice()).toBe(40000)
    clock.advance()
    expect(await bn.getPrice()).toBe(40500)
  })

  it('getFundingRate returns clock rate', async () => {
    expect(await bn.getFundingRate()).toBe(0.005)
  })

  it('getOrderbook returns 5 levels', async () => {
    const ob = await bn.getOrderbook()
    expect(ob.bids).toHaveLength(5)
    expect(ob.asks).toHaveLength(5)
  })

  it('getBalance returns initial balance', async () => {
    expect(await bn.getBalance()).toBe(0.5)
  })

  describe('openPosition + closePosition', () => {
    it('tracks position and calculates PnL', async () => {
      // Open LONG at 40000
      const result = await bn.openPosition('LONG', 1.0, 2)
      expect(result.status).toBe('closed')
      expect(result.price).toBe(40000)

      const pos = await bn.getPosition()
      expect(pos).not.toBeNull()
      expect(pos!.side).toBe('LONG')
      expect(pos!.entryPrice).toBe(40000)

      // Advance to 40500
      clock.advance()
      const closedResult = await bn.closePosition('LONG', 1.0)
      expect(closedResult.price).toBe(40500)

      // No position after close
      expect(await bn.getPosition()).toBeNull()

      // Balance should have increased
      const balance = await bn.getBalance()
      expect(balance).toBeGreaterThan(0.5)
    })

    it('SHORT profit when price drops', async () => {
      await bn.openPosition('SHORT', 1.0, 2)
      clock.advance()
      clock.advance() // price 39500

      await bn.closePosition('SHORT', 1.0)
      expect(await bn.getBalance()).toBeGreaterThan(0.5)
    })

    it('throws when closing with no position', async () => {
      await expect(bn.closePosition('LONG', 1.0)).rejects.toThrow('No open position')
    })
  })

  it('getPositions returns array', async () => {
    expect(await bn.getPositions()).toEqual([])
    await bn.openPosition('LONG', 1.0, 2)
    const positions = await bn.getPositions()
    expect(positions).toHaveLength(1)
  })

  it('close() does not throw', async () => {
    await expect(bn.close()).resolves.toBeUndefined()
  })

  it('watchPrice returns cleanup function', async () => {
    const cleanup = await bn.watchPrice(() => {})
    expect(typeof cleanup).toBe('function')
    cleanup() // should not throw
  })
})
