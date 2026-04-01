import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, and } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type {
  Database,
  StrategyRecord,
  PositionRecord,
  TradeRecord,
  AccountRecord,
  AlertRecord,
} from '../types/index.js'
import { strategies, positions, trades, accounts, alerts, keyValue } from './schema.js'

// DDL executed once on database creation — no migration runner needed.
const DDL = `
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  exchange TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  size REAL NOT NULL,
  leverage REAL NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  type TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  fee REAL NOT NULL,
  pnl REAL NOT NULL,
  executed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  account_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  balance REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  strategy_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_value (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function now(): string {
  return new Date().toISOString()
}

function uuid(): string {
  return crypto.randomUUID()
}

export function createDatabase(path: string): Database {
  const sqlite = new BetterSqlite3(path)
  // Apply schema — idempotent via IF NOT EXISTS
  sqlite.exec(DDL)

  const db: BetterSQLite3Database = drizzle(sqlite)

  return {
    // ── Strategies ──────────────────────────────────────────────────

    createStrategy(data) {
      const record: StrategyRecord = {
        id: uuid(),
        name: data.name,
        type: data.type,
        status: data.status,
        config: data.config,
        createdAt: now(),
        updatedAt: now(),
      }
      db.insert(strategies).values(record).run()
      return record
    },

    getStrategy(id) {
      const row = db.select().from(strategies).where(eq(strategies.id, id)).get()
      return row as StrategyRecord | undefined
    },

    updateStrategy(id, data) {
      const patch: Partial<StrategyRecord> = { ...data, updatedAt: now() }
      db.update(strategies).set(patch).where(eq(strategies.id, id)).run()
      const row = db.select().from(strategies).where(eq(strategies.id, id)).get()
      return row as StrategyRecord | undefined
    },

    listStrategies(filter?) {
      let query = db.select().from(strategies).$dynamic()
      const conditions = []
      if (filter?.status) conditions.push(eq(strategies.status, filter.status))
      if (filter?.type) conditions.push(eq(strategies.type, filter.type))
      if (conditions.length === 1) query = query.where(conditions[0])
      if (conditions.length > 1) query = query.where(and(...conditions))
      return query.all() as StrategyRecord[]
    },

    // ── Positions ───────────────────────────────────────────────────

    createPosition(data) {
      const record: PositionRecord = {
        id: uuid(),
        strategyId: data.strategyId,
        exchange: data.exchange,
        side: data.side,
        entryPrice: data.entryPrice,
        size: data.size,
        leverage: data.leverage,
        status: data.status,
        openedAt: now(),
        closedAt: null,
      }
      db.insert(positions).values(record).run()
      return record
    },

    getPosition(id) {
      const row = db.select().from(positions).where(eq(positions.id, id)).get()
      return row as PositionRecord | undefined
    },

    updatePosition(id, data) {
      db.update(positions).set(data).where(eq(positions.id, id)).run()
      const row = db.select().from(positions).where(eq(positions.id, id)).get()
      return row as PositionRecord | undefined
    },

    listPositions(filter?) {
      let query = db.select().from(positions).$dynamic()
      const conditions = []
      if (filter?.strategyId) conditions.push(eq(positions.strategyId, filter.strategyId))
      if (filter?.status) conditions.push(eq(positions.status, filter.status))
      if (filter?.exchange) conditions.push(eq(positions.exchange, filter.exchange))
      if (conditions.length === 1) query = query.where(conditions[0])
      if (conditions.length > 1) query = query.where(and(...conditions))
      return query.all() as PositionRecord[]
    },

    // ── Trades ──────────────────────────────────────────────────────

    createTrade(data) {
      const record: TradeRecord = {
        id: uuid(),
        positionId: data.positionId,
        type: data.type,
        price: data.price,
        size: data.size,
        fee: data.fee,
        pnl: data.pnl,
        executedAt: now(),
      }
      db.insert(trades).values(record).run()
      return record
    },

    listTrades(filter?) {
      if (filter?.strategyId) {
        // Join through positions to filter by strategyId
        const rows = db
          .select({ trades })
          .from(trades)
          .innerJoin(positions, eq(trades.positionId, positions.id))
          .where(eq(positions.strategyId, filter.strategyId))
          .all()
        return rows.map((r: any) => r.trades) as TradeRecord[]
      }

      let query = db.select().from(trades).$dynamic()
      if (filter?.positionId) query = query.where(eq(trades.positionId, filter.positionId))
      return query.all() as TradeRecord[]
    },

    // ── Accounts ────────────────────────────────────────────────────

    createAccount(data) {
      const record: AccountRecord = {
        id: uuid(),
        exchange: data.exchange,
        accountIndex: data.accountIndex,
        status: data.status,
        balance: data.balance,
      }
      db.insert(accounts).values(record).run()
      return record
    },

    getAccount(exchange, accountIndex) {
      const row = db
        .select()
        .from(accounts)
        .where(and(eq(accounts.exchange, exchange), eq(accounts.accountIndex, accountIndex)))
        .get()
      return row as AccountRecord | undefined
    },

    updateAccount(id, data) {
      db.update(accounts).set(data).where(eq(accounts.id, id)).run()
      const row = db.select().from(accounts).where(eq(accounts.id, id)).get()
      return row as AccountRecord | undefined
    },

    listAccounts(filter?) {
      let query = db.select().from(accounts).$dynamic()
      const conditions = []
      if (filter?.exchange) conditions.push(eq(accounts.exchange, filter.exchange))
      if (filter?.status) conditions.push(eq(accounts.status, filter.status))
      if (conditions.length === 1) query = query.where(conditions[0])
      if (conditions.length > 1) query = query.where(and(...conditions))
      return query.all() as AccountRecord[]
    },

    // ── Alerts ──────────────────────────────────────────────────────

    createAlert(data) {
      const record: AlertRecord = {
        id: uuid(),
        strategyId: data.strategyId,
        type: data.type,
        message: data.message,
        sentAt: now(),
      }
      db.insert(alerts).values(record).run()
      return record
    },

    listAlerts(filter?) {
      let query = db.select().from(alerts).$dynamic()
      const conditions = []
      if (filter?.strategyId) conditions.push(eq(alerts.strategyId, filter.strategyId))
      if (filter?.type) conditions.push(eq(alerts.type, filter.type))
      if (conditions.length === 1) query = query.where(conditions[0])
      if (conditions.length > 1) query = query.where(and(...conditions))
      if (filter?.limit) query = query.limit(filter.limit)
      return query.all() as AlertRecord[]
    },

    // ── Key-Value ────────────────────────────────────────────────────

    getKV(key) {
      const row = db.select().from(keyValue).where(eq(keyValue.key, key)).get()
      return row?.value
    },

    setKV(key, value) {
      db
        .insert(keyValue)
        .values({ key, value })
        .onConflictDoUpdate({ target: keyValue.key, set: { value } })
        .run()
    },
  }
}
