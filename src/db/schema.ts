import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core'

export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  config: text('config').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const positions = sqliteTable('positions', {
  id: text('id').primaryKey(),
  strategyId: text('strategy_id').notNull().references(() => strategies.id),
  exchange: text('exchange').notNull(),
  side: text('side').notNull(),
  entryPrice: real('entry_price').notNull(),
  size: real('size').notNull(),
  leverage: real('leverage').notNull(),
  status: text('status').notNull(),
  openedAt: text('opened_at').notNull(),
  closedAt: text('closed_at'),
})

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(),
  positionId: text('position_id').notNull().references(() => positions.id),
  type: text('type').notNull(),
  price: real('price').notNull(),
  size: real('size').notNull(),
  fee: real('fee').notNull(),
  pnl: real('pnl').notNull(),
  executedAt: text('executed_at').notNull(),
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  exchange: text('exchange').notNull(),
  accountIndex: integer('account_index').notNull(),
  status: text('status').notNull(),
  balance: real('balance').notNull(),
})

export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  strategyId: text('strategy_id'),
  type: text('type').notNull(),
  message: text('message').notNull(),
  sentAt: text('sent_at').notNull(),
})

export const keyValue = sqliteTable('key_value', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
