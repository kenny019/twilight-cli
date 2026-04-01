# Workstreams

## Dependency Order
1. WS-1: Shared Types & Config (no deps)
2. WS-2: Database Layer (depends: 1)
3. WS-3: Twilight Client (depends: 1)
4. WS-4: Binance Client (depends: 1)
5. WS-5: Discord Alerts (depends: 1)
6. WS-6: Risk Management (depends: 1, 2)
7. WS-7: Strategy Engine (depends: 1, 2, 6)
8. WS-8: REST API (depends: 1, 2, 7)
9. WS-9: Template Strategies (depends: 1, 3, 4, 5, 6, 7)
10. WS-10: CLI (depends: 1, 2, 8)
11. WS-11: Docker & Deploy (depends: all)

## Execution Batches
```
Batch 1 (parallel): WS-1
Batch 2 (parallel): WS-2, WS-3, WS-4, WS-5
Batch 3 (parallel): WS-6
Batch 4 (parallel): WS-7, WS-8
Batch 5 (parallel): WS-9, WS-10
Batch 6:            WS-11
```

---

## WS-1: Shared Types & Config

**Scope:** `src/types/`, `src/config/`
**Depends on:** none
**Exposes:** Strategy interface, Context type, StrategyConfig, StrategyStatus, exchange client interfaces (TwilightClient, BinanceClient), RiskManager interface, AlertClient interface, Logger interface, Database interface, config schema, risk profile types, JSON schema types
**Agent type:** backend-developer
**Test file:** `src/types/__tests__/types.test.ts`

### Requirements
- Define `Strategy` interface with id, name, description, configSchema, init(), tick(), stop(), status()
- Define `Context` interface with twilight, binance, risk, log, db, alert clients
- Define `TwilightClient` interface wrapping relayer-cli operations (fund, withdraw, transfer, split, openTrade, closeTrade, cancelTrade, queryTrade, unlockTrade, openLend, closeLend, queryLend, marketPrice, fundingRate, feeRate, marketStats, lendPool, lastDayApy, walletBalance, walletAccounts)
- Define `BinanceClient` interface wrapping ccxt (getPrice, getFundingRate, openPosition, closePosition, getPosition, getBalance, watchPrice, watchFundingRate)
- Define `RiskManager` interface with checkPreTrade(), checkDrawdown(), checkDailyLoss(), isKillSwitchActive(), activateKillSwitch(), deactivateKillSwitch()
- Define `AlertClient` interface with send(), sendTradeAlert(), sendErrorAlert(), sendRiskAlert()
- Define `StrategyStatus` type (active/stopped/error) and `StrategyConfig` type
- Define risk profile types: Conservative, Moderate, Aggressive with default values from PRD section 11
- Define config schema type for `~/.twilight-bots/config.json`
- Define `Logger` interface with info(), warn(), error(), debug()
- Define `Database` interface for state operations

### Acceptance Criteria
- All interfaces compile with TypeScript strict mode
- Interfaces match PRD section 10.1 Strategy interface exactly
- Risk profile defaults match PRD section 11 table
- Config schema covers all setup wizard outputs (wallet, binance keys, discord webhook, strategies, risk profile)

---

## WS-2: Database Layer

**Scope:** `src/db/`
**Depends on:** WS-1
**Exposes:** `createDatabase()`, Drizzle schema, repository functions (strategies CRUD, positions CRUD, trades CRUD, accounts CRUD, alerts CRUD)
**Agent type:** backend-developer
**Test file:** `src/db/__tests__/db.test.ts`

### Requirements
- Set up Drizzle ORM with better-sqlite3
- Define tables per PRD section 9.5: strategies, positions, trades, accounts, alerts
- `strategies` table: id, name, type (template/custom), status (active/stopped/error), config (JSON text), created_at, updated_at
- `positions` table: id, strategy_id, exchange, side, entry_price, size, leverage, status, opened_at, closed_at
- `trades` table: id, position_id, type (open/close), price, size, fee, pnl, executed_at
- `accounts` table: id, exchange, account_index, status (idle/active/locked), balance
- `alerts` table: id, strategy_id, type, message, sent_at
- Implement repository functions for each table (create, read, update, list with filters)
- Database path: `~/.twilight-bots/data.db` (local) or `/app/data/data.db` (Docker via env var)
- Auto-create database and run migrations on first use

### Acceptance Criteria
- All CRUD operations work for each table
- Foreign key relationships enforced (positions to strategies, trades to positions)
- JSON config round-trips correctly (store/retrieve)
- Database file created automatically at configured path
- Timestamps auto-populated on insert

---

## WS-3: Twilight Client

**Scope:** `src/exchanges/twilight.ts`
**Depends on:** WS-1
**Exposes:** `TwilightClientImpl` class implementing `TwilightClient` interface
**Agent type:** backend-developer
**Test file:** `src/exchanges/__tests__/twilight.test.ts`

### Requirements
- Wrap relayer-cli binary via execFile (NOT exec, to prevent shell injection) with `--json` flag
- Parse JSON output from relayer-cli into typed responses
- Implement all TwilightClient interface methods:
  - Wallet: balance, accounts
  - ZkAccount: fund, withdraw, transfer (account rotation), split
  - Orders: openTrade, closeTrade, cancelTrade, queryTrade, unlockTrade
  - Lending: openLend, closeLend, queryLend
  - Market: price, fundingRate, feeRate, marketStats, lendPool, lastDayApy, orderbook
- Handle Twilight-specific mechanics transparently (PRD section 10.4):
  - Account rotation: auto-run `zkaccount transfer --from N` after closing a trade
  - Nonce management: sync nonces before transactions
  - SLTP unlock: run `order unlock-trade` after stop-loss/take-profit settles
- Configure via environment variables: wallet-id, password, relayer-cli binary path
- Timeout handling for CLI commands (30s default)
- Error parsing: extract meaningful error messages from stderr

### Acceptance Criteria
- All interface methods implemented with correct relayer-cli command mapping
- JSON output parsed into typed objects
- Account rotation happens automatically after closeTrade
- Errors from relayer-cli are caught and wrapped in typed errors
- Binary path configurable (default: `./bin/relayer-cli`)

---

## WS-4: Binance Client

**Scope:** `src/exchanges/binance.ts`
**Depends on:** WS-1
**Exposes:** `BinanceClientImpl` class implementing `BinanceClient` interface
**Agent type:** backend-developer
**Test file:** `src/exchanges/__tests__/binance.test.ts`

### Requirements
- Wrap ccxt with production-grade additions (PRD section 10.5)
- Implement BinanceClient interface methods:
  - Market data: getPrice, getFundingRate, getOrderbook
  - Trading: openPosition (market/limit), closePosition, getPosition, getPositions
  - Account: getBalance, getMarginBalance
  - WebSocket: watchPrice, watchFundingRate (using ccxt.pro with REST fallback)
- Order lifecycle tracking: in-flight order management, state reconciliation
- Retry logic: exponential backoff on transient failures (rate limits, network errors)
- Staleness detection: flag stale WebSocket data after configurable timeout, fall back to REST
- Binance-specific config: precision, fee model (0.04% taker), partial fill handling
- Configure via API key + secret from environment variables

### Acceptance Criteria
- All interface methods implemented using ccxt
- Order lifecycle tracked from submission through fill
- Retry logic handles rate limit (429) and network errors
- WebSocket methods fall back to REST polling on failure
- API credentials never logged

---

## WS-5: Discord Alerts

**Scope:** `src/alerts/discord.ts`
**Depends on:** WS-1
**Exposes:** `DiscordAlertClient` class implementing `AlertClient` interface
**Agent type:** backend-developer
**Test file:** `src/alerts/__tests__/discord.test.ts`

### Requirements
- Implement AlertClient interface using Discord webhooks (PRD section 7.4)
- Alert types: strategy start/stop, trade execution, PnL milestones, errors, liquidation risk, connection issues
- Message formatting: rich embeds with color coding (green=success, yellow=warning, red=error)
- Rate limiting: respect Discord webhook rate limits (30 messages/minute)
- Queue system: batch alerts if rate limited, do not drop messages
- Configurable webhook URL from environment variable
- Test message on setup verification
- Graceful degradation: log locally if webhook unreachable, do not crash the bot

### Acceptance Criteria
- All alert types send correctly formatted Discord embeds
- Rate limiting prevents 429 errors from Discord
- Failed webhook calls do not crash the application
- Webhook URL validated on construction
- send() method returns success/failure without throwing

---

## WS-6: Risk Management

**Scope:** `src/engine/risk.ts`
**Depends on:** WS-1, WS-2
**Exposes:** `RiskManagerImpl` class implementing `RiskManager` interface
**Agent type:** backend-developer
**Test file:** `src/engine/__tests__/risk.test.ts`

### Requirements
- Implement all risk controls from PRD section 11:
  - Max drawdown: auto-stop strategy at threshold (10%/20%/30% by profile)
  - Position size cap: never exceed X% of balance per strategy (30%/50%/80%)
  - Rate floor: funding arb will not enter if rate < fee cost + minimum profit
  - Connection watchdog: pause strategies if exchange unreachable >60s
  - Daily loss limit: stop trading for day at 5% of balance
  - Cooldown period: wait after losing trade (15min/5min/0 by profile)
  - Kill switch: emergency stop all, persists across restarts (stored in DB)
- Pre-trade check method: validates all risk conditions before allowing a trade
- Risk profile loading from config (conservative/moderate/aggressive)
- Every risk event returns structured data for alerting
- Kill switch state persisted in SQLite

### Acceptance Criteria
- All 7 risk controls implemented and independently testable
- Risk profiles match PRD section 11 default values exactly
- Pre-trade check rejects when ANY condition fails
- Kill switch persists across process restarts
- Drawdown calculated correctly from trade history

---

## WS-7: Strategy Engine

**Scope:** `src/engine/scheduler.ts`, `src/engine/loader.ts`
**Depends on:** WS-1, WS-2, WS-6
**Exposes:** `Scheduler` class, `StrategyLoader` class
**Agent type:** backend-developer
**Test file:** `src/engine/__tests__/engine.test.ts`

### Requirements
- **Scheduler** (PRD section 10.3):
  - Run each active strategy's tick() on its configured interval (e.g., 60s funding arb, 300s lending)
  - Strategy isolation: one failing does not affect others
  - Catch and log errors per-tick (no unhandled crashes)
  - Report tick duration and success/failure
  - Respect risk manager kill switch (skip tick if active)
  - Graceful shutdown on SIGTERM (PRD section 11): stop ticks, cancel pending orders, save state, close connections, exit
  - Open positions NOT closed on restart; persist and resume
- **Loader** (PRD section 10.2):
  - Scan `strategies/templates/` and `strategies/custom/` at boot
  - Register any `.ts` file exporting a class implementing Strategy interface
  - Dynamic import with validation

### Acceptance Criteria
- Strategies tick independently on configured intervals
- One strategy throwing does not stop others
- Kill switch stops all ticks immediately
- SIGTERM triggers graceful shutdown sequence
- Loader discovers and registers strategy files from both directories
- Strategy state persists across restarts via database

---

## WS-8: REST API

**Scope:** `src/server.ts`, `src/routes/`, `src/middleware/`
**Depends on:** WS-1, WS-2, WS-7
**Exposes:** Hono HTTP server with all endpoints from PRD section 9.4
**Agent type:** backend-developer
**Test file:** `src/routes/__tests__/api.test.ts`

### Requirements
- Hono server with all endpoints from PRD section 9.4:
  - GET `/health` (no auth required)
  - GET `/status` - all running strategies + state
  - GET `/positions` - open positions (Twilight + Binance)
  - GET `/pnl` - PnL summary per-strategy + total
  - GET `/history` - trade history with filters
  - POST `/strategies/:id/start` - start a strategy with config
  - POST `/strategies/:id/stop` - gracefully stop a strategy
  - PUT `/strategies/:id/config` - update parameters
  - GET `/strategies/:id/logs` - recent structured log entries
- Bearer token auth middleware on all endpoints except /health
- Token from `BEARER_TOKEN` environment variable
- JSON responses, proper HTTP status codes
- Health endpoint includes: uptime, active strategies count, last tick times
- Performance: <200ms response for status/position queries

### Acceptance Criteria
- All 9 endpoints return correct responses
- Bearer token auth rejects unauthorized requests
- /health works without auth
- Strategy start/stop integrates with scheduler
- JSON responses match documented schema

---

## WS-9: Template Strategies

**Scope:** `src/strategies/templates/funding-arb.ts`, `src/strategies/templates/lending-yield.ts`
**Depends on:** WS-1, WS-3, WS-4, WS-5, WS-6, WS-7
**Exposes:** `FundingArbStrategy`, `LendingYieldStrategy` classes
**Agent type:** backend-developer
**Test file:** `src/strategies/__tests__/strategies.test.ts`

### Requirements
- **Funding Rate Arbitrage** (PRD section 7.2):
  - Monitor funding rate differential between Twilight and Binance
  - Open delta-neutral position when rate > threshold (covers fees + target profit)
  - Close when rate normalizes or reverses
  - Handle Twilight mechanics: ZkOS account funding, account rotation after close
  - Configurable: entry threshold, exit threshold, position size, check interval
- **Lending Yield** (PRD section 7.2):
  - Deploy idle BTC to Twilight lending pool
  - Monitor APY, rebalance based on configurable thresholds
  - Withdraw if APY drops below minimum or risk conditions trigger
  - Configurable: min APY threshold, rebalance threshold, check interval
- Both implement Strategy interface completely
- Both include configSchema (JSON Schema) for CLI validation
- Both use Context for all external interactions

### Acceptance Criteria
- Both strategies implement full Strategy interface
- Funding arb opens delta-neutral positions correctly (long one / short other)
- Funding arb respects rate floor from risk manager
- Lending yield deploys to pool and monitors APY
- Both respond to stop() gracefully
- configSchema validates strategy-specific parameters

---

## WS-10: CLI

**Scope:** `src/cli/`
**Depends on:** WS-1, WS-2, WS-8
**Exposes:** CLI entry point (`twilight-bots` command)
**Agent type:** backend-developer
**Test file:** `src/cli/__tests__/cli.test.ts`

### Requirements
- CLI entry point using commander (PRD section 7.1, 7.4)
- **Setup wizard** (interactive, deterministic, PRD section 7.1):
  - Step 1: Twilight Wallet (create new or import existing mnemonic)
  - Step 2: Binance API Keys (key + secret, verify connection)
  - Step 3: Discord Alerts (webhook URL, send test message)
  - Step 4: Strategy Selection (toggle funding arb, lending yield)
  - Step 5: Risk Profile (conservative/moderate/aggressive)
  - Output: `~/.twilight-bots/config.json`
- **Management commands** (PRD section 7.4):
  - `status` - running strategies + PnL (calls REST API)
  - `start <strategy>` - activate a strategy
  - `stop <strategy>` - deactivate a strategy
  - `config` - view/edit strategy params
  - `wallet` - balance, accounts, fund/withdraw
  - `market` - price, funding rate, orderbook
  - `logs` - tail bot logs
- All management commands call the REST API (bot may be running on Railway)
- Config stored at `~/.twilight-bots/config.json`

### Acceptance Criteria
- Setup wizard completes all 5 steps and writes valid config
- All management commands make correct REST API calls
- CLI handles connection errors gracefully (bot not running)
- Config file round-trips correctly
- `--help` works for all commands

---

## WS-11: Docker & Deploy

**Scope:** `Dockerfile`, `railway.json`, `docker-compose.yml`, `.env.example`, `railway.toml`
**Depends on:** all previous workstreams
**Exposes:** Deployable Docker image, Railway one-click config
**Agent type:** backend-developer
**Test file:** `tests/deploy.test.ts`

### Requirements
- **Dockerfile** (PRD section 9.1, 16):
  - Multi-stage build: deps, build, runtime
  - Bundle relayer-cli Linux x86_64 binary in `bin/`
  - Node.js 20 Alpine base
  - Expose port 3000
  - Health check using /health endpoint
  - Minimal (~15 lines)
- **railway.json**: one-click deploy button config
- **railway.toml**: Railway-specific build/deploy config
- **docker-compose.yml**: local/VPS deployment with persistent volume for SQLite
- **.env.example**: all required environment variables with descriptions
- Entry point: `node dist/server.js` (starts both API server and strategy engine)

### Acceptance Criteria
- Dockerfile builds successfully
- docker-compose up starts the service with persistent data volume
- .env.example documents all required and optional env vars
- Railway config enables one-click deploy
- Health check works in Docker
