/**
 * Validation contract for WS-2: Database Layer
 * Tests define "done" — do not modify without orchestrator approval.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createDatabase } from '../index.js'
import type { Database } from '../../types/index.js'

const TEST_DB_DIR = join(tmpdir(), 'twilight-bots-test-' + process.pid)
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')

describe('WS-2: Database Layer', () => {
  let db: Database

  beforeEach(() => {
    mkdirSync(TEST_DB_DIR, { recursive: true })
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH)
    db = createDatabase(TEST_DB_PATH)
  })

  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH)
  })

  describe('Database creation', () => {
    it('creates the database file at the specified path', () => {
      expect(existsSync(TEST_DB_PATH)).toBe(true)
    })

    it('auto-creates tables on first use', () => {
      const strategies = db.listStrategies()
      expect(strategies).toEqual([])
    })
  })

  describe('Strategies CRUD', () => {
    it('creates a strategy with auto-generated id and timestamps', () => {
      const strategy = db.createStrategy({
        name: 'Funding Arb',
        type: 'template',
        status: 'stopped',
        config: JSON.stringify({ threshold: 0.01 }),
      })
      expect(strategy.id).toBeTruthy()
      expect(strategy.name).toBe('Funding Arb')
      expect(strategy.createdAt).toBeTruthy()
      expect(strategy.updatedAt).toBeTruthy()
    })

    it('gets a strategy by id', () => {
      const created = db.createStrategy({
        name: 'Test',
        type: 'custom',
        status: 'stopped',
        config: '{}',
      })
      const found = db.getStrategy(created.id)
      expect(found).toBeDefined()
      expect(found!.name).toBe('Test')
    })

    it('returns undefined for non-existent strategy', () => {
      expect(db.getStrategy('nonexistent')).toBeUndefined()
    })

    it('updates strategy status and config', () => {
      const created = db.createStrategy({
        name: 'Test',
        type: 'template',
        status: 'stopped',
        config: '{}',
      })
      const updated = db.updateStrategy(created.id, {
        status: 'active',
        config: JSON.stringify({ interval: 60 }),
      })
      expect(updated).toBeDefined()
      expect(updated!.status).toBe('active')
      expect(JSON.parse(updated!.config)).toEqual({ interval: 60 })
    })

    it('lists strategies with filters', () => {
      db.createStrategy({ name: 'A', type: 'template', status: 'active', config: '{}' })
      db.createStrategy({ name: 'B', type: 'custom', status: 'stopped', config: '{}' })
      db.createStrategy({ name: 'C', type: 'template', status: 'stopped', config: '{}' })

      expect(db.listStrategies()).toHaveLength(3)
      expect(db.listStrategies({ status: 'active' })).toHaveLength(1)
      expect(db.listStrategies({ type: 'template' })).toHaveLength(2)
    })

    it('round-trips JSON config correctly', () => {
      const config = { threshold: 0.01, nested: { a: [1, 2, 3] } }
      const created = db.createStrategy({
        name: 'Test',
        type: 'template',
        status: 'stopped',
        config: JSON.stringify(config),
      })
      const found = db.getStrategy(created.id)
      expect(JSON.parse(found!.config)).toEqual(config)
    })
  })

  describe('Positions CRUD', () => {
    let strategyId: string

    beforeEach(() => {
      const strategy = db.createStrategy({
        name: 'Test',
        type: 'template',
        status: 'active',
        config: '{}',
      })
      strategyId = strategy.id
    })

    it('creates a position with auto-generated id and timestamp', () => {
      const pos = db.createPosition({
        strategyId,
        exchange: 'twilight',
        side: 'LONG',
        entryPrice: 65000,
        size: 10000,
        leverage: 5,
        status: 'open',
      })
      expect(pos.id).toBeTruthy()
      expect(pos.openedAt).toBeTruthy()
      expect(pos.closedAt).toBeNull()
    })

    it('updates position status and closedAt', () => {
      const pos = db.createPosition({
        strategyId,
        exchange: 'binance',
        side: 'SHORT',
        entryPrice: 65000,
        size: 10000,
        leverage: 5,
        status: 'open',
      })
      const updated = db.updatePosition(pos.id, {
        status: 'closed',
        closedAt: new Date().toISOString(),
      })
      expect(updated!.status).toBe('closed')
      expect(updated!.closedAt).toBeTruthy()
    })

    it('lists positions with filters', () => {
      db.createPosition({ strategyId, exchange: 'twilight', side: 'LONG', entryPrice: 65000, size: 10000, leverage: 5, status: 'open' })
      db.createPosition({ strategyId, exchange: 'binance', side: 'SHORT', entryPrice: 65000, size: 10000, leverage: 5, status: 'open' })
      db.createPosition({ strategyId, exchange: 'twilight', side: 'LONG', entryPrice: 64000, size: 5000, leverage: 3, status: 'closed' })

      expect(db.listPositions()).toHaveLength(3)
      expect(db.listPositions({ exchange: 'twilight' })).toHaveLength(2)
      expect(db.listPositions({ status: 'open' })).toHaveLength(2)
      expect(db.listPositions({ strategyId })).toHaveLength(3)
    })
  })

  describe('Trades CRUD', () => {
    it('creates a trade with auto-generated id and timestamp', () => {
      const strategy = db.createStrategy({ name: 'T', type: 'template', status: 'active', config: '{}' })
      const pos = db.createPosition({ strategyId: strategy.id, exchange: 'twilight', side: 'LONG', entryPrice: 65000, size: 10000, leverage: 5, status: 'open' })
      const trade = db.createTrade({
        positionId: pos.id,
        type: 'open',
        price: 65000,
        size: 10000,
        fee: 400,
        pnl: 0,
      })
      expect(trade.id).toBeTruthy()
      expect(trade.executedAt).toBeTruthy()
    })

    it('lists trades by position and strategy', () => {
      const strategy = db.createStrategy({ name: 'T', type: 'template', status: 'active', config: '{}' })
      const pos = db.createPosition({ strategyId: strategy.id, exchange: 'twilight', side: 'LONG', entryPrice: 65000, size: 10000, leverage: 5, status: 'open' })
      db.createTrade({ positionId: pos.id, type: 'open', price: 65000, size: 10000, fee: 400, pnl: 0 })
      db.createTrade({ positionId: pos.id, type: 'close', price: 66000, size: 10000, fee: 400, pnl: 500 })

      expect(db.listTrades({ positionId: pos.id })).toHaveLength(2)
      expect(db.listTrades({ strategyId: strategy.id })).toHaveLength(2)
    })
  })

  describe('Accounts CRUD', () => {
    it('creates and retrieves an account', () => {
      const account = db.createAccount({
        exchange: 'twilight',
        accountIndex: 0,
        status: 'idle',
        balance: 50000,
      })
      expect(account.id).toBeTruthy()

      const found = db.getAccount('twilight', 0)
      expect(found).toBeDefined()
      expect(found!.balance).toBe(50000)
    })

    it('updates account status and balance', () => {
      const account = db.createAccount({
        exchange: 'twilight',
        accountIndex: 1,
        status: 'idle',
        balance: 50000,
      })
      const updated = db.updateAccount(account.id, { status: 'active', balance: 45000 })
      expect(updated!.status).toBe('active')
      expect(updated!.balance).toBe(45000)
    })

    it('lists accounts with filters', () => {
      db.createAccount({ exchange: 'twilight', accountIndex: 0, status: 'idle', balance: 50000 })
      db.createAccount({ exchange: 'twilight', accountIndex: 1, status: 'active', balance: 30000 })
      db.createAccount({ exchange: 'binance', accountIndex: 0, status: 'idle', balance: 100000 })

      expect(db.listAccounts()).toHaveLength(3)
      expect(db.listAccounts({ exchange: 'twilight' })).toHaveLength(2)
      expect(db.listAccounts({ status: 'idle' })).toHaveLength(2)
    })
  })

  describe('Alerts CRUD', () => {
    it('creates an alert with auto-generated id and timestamp', () => {
      const alert = db.createAlert({
        strategyId: null,
        type: 'info',
        message: 'Bot started',
      })
      expect(alert.id).toBeTruthy()
      expect(alert.sentAt).toBeTruthy()
    })

    it('lists alerts with filters and limit', () => {
      db.createAlert({ strategyId: 's1', type: 'trade', message: 'Opened LONG' })
      db.createAlert({ strategyId: 's1', type: 'error', message: 'Connection lost' })
      db.createAlert({ strategyId: 's2', type: 'trade', message: 'Closed SHORT' })

      expect(db.listAlerts()).toHaveLength(3)
      expect(db.listAlerts({ strategyId: 's1' })).toHaveLength(2)
      expect(db.listAlerts({ type: 'trade' })).toHaveLength(2)
      expect(db.listAlerts({ limit: 1 })).toHaveLength(1)
    })
  })

  describe('Key-Value store', () => {
    it('stores and retrieves a key-value pair', () => {
      db.setKV('kill_switch', 'true')
      expect(db.getKV('kill_switch')).toBe('true')
    })

    it('returns undefined for non-existent key', () => {
      expect(db.getKV('nonexistent')).toBeUndefined()
    })

    it('overwrites existing key', () => {
      db.setKV('kill_switch', 'true')
      db.setKV('kill_switch', 'false')
      expect(db.getKV('kill_switch')).toBe('false')
    })
  })
})
