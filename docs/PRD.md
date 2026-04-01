# Twilight Bots — Product Requirements Document

**Version:** 1.0
**Date:** 2026-04-01
**Status:** Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Product Vision & Positioning](#3-product-vision--positioning)
4. [Target Users](#4-target-users)
5. [Market Context](#5-market-context)
6. [Launch Scope](#6-launch-scope)
7. [Core Product Features](#7-core-product-features)
8. [Revenue Model](#8-revenue-model)
9. [Technical Architecture](#9-technical-architecture)
10. [Strategy Engine](#10-strategy-engine)
11. [Risk Management](#11-risk-management)
12. [Non-Functional Requirements](#12-non-functional-requirements)
13. [Success Metrics](#13-success-metrics)
14. [Roadmap & Phasing](#14-roadmap--phasing)
15. [Risks & Mitigations](#15-risks--mitigations)
16. [Resolved Decisions](#16-resolved-decisions)

---

## 1. Executive Summary

Twilight Bots is an open-source, CLI-first trading bot platform that lets users run automated strategies on Twilight Protocol and Binance. Users onboard through a deterministic CLI setup wizard, choose from battle-tested template strategies (funding rate arbitrage, lending yield), and deploy to Railway with one click.

The differentiator: an AI agent (Claude Code) can create custom trading strategies from natural language descriptions — "the Cursor for crypto trading." Non-technical users describe what they want, the agent writes executable strategy code, commits it, and Railway auto-deploys.

This is an ecosystem growth play for Twilight Protocol — free and open-source, designed to drive TVL and trading volume by making automated strategy deployment accessible to non-technical crypto users.

---

## 2. Problem Statement

Automated crypto trading is a $41.6B market growing at 14% CAGR, yet the tools remain inaccessible to the majority of traders:

- **Config-file hell**: Open-source bots (Freqtrade, Hummingbot) require Python knowledge, YAML/JSON config editing, Docker expertise, and SSH access to servers.
- **Walled gardens**: Exchange-native AI tools (Binance AI Pro, Gate.io AI Quant) are locked to single exchanges and don't support DeFi protocols.
- **No DeFi automation layer**: Tools for funding rate arbitrage, delta-neutral strategies, and DeFi lending exist at the protocol level (Ethena) but not as customizable, user-controlled bots.
- **Twilight Protocol is manual**: Existing Twilight users execute strategies by hand using the CLI or REST API. No automation framework exists.

**Key pain points:**
- Non-technical crypto users understand strategies conceptually but can't implement them
- Technical users waste time on plumbing (exchange connections, account rotation, risk management) instead of strategy logic
- No tool combines DeFi protocol support + AI strategy creation + one-click deployment

---

## 3. Product Vision & Positioning

**Vision:** Make automated trading on Twilight Protocol as easy as describing what you want in plain English.

**Positioning:** "The Cursor for crypto trading" — AI writes your trading strategies like Cursor writes your code. Conversational, not config-driven.

**Differentiation:**
- **CLI-first onboarding**: Deterministic setup wizard inspired by Hermes Agent. No config files to edit.
- **AI strategy creation**: Claude Code skill lets non-technical users create custom strategies via natural language. No competitor offers this for DeFi protocols.
- **DeFi-native**: Built on Twilight Protocol's inverse perpetuals and lending pool — not another CEX-only wrapper.
- **Flexible deploy**: Railway one-click, VPS via docker-compose, or local Docker Desktop. Same image everywhere.
- **Open-source**: Free, community-driven. Ecosystem growth play, not SaaS.
- **Battle-tested CLI**: Uses `relayer-cli` directly — the same tool Twilight power users already trust.

---

## 4. Target Users

**Primary audience:** Crypto-native individuals who understand trading concepts but lack the technical ability to build and deploy trading bots.

| Segment | Behavior | What They Value |
|---------|----------|-----------------|
| **Crypto-native, non-technical** | Understand DeFi/trading concepts, follow funding rates, read CT. Can't code. | "Just work" automation. Plain-English strategy creation. No config files. |
| **Traders who code** | Write basic scripts, have used exchange APIs. Don't want to build the plumbing. | Framework that handles exchange connections, account rotation, risk management. They focus on strategy logic. |
| **Existing Twilight users** | Already use relayer-cli manually. Execute strategies by hand. | Automation of what they already do. Fewer manual steps, 24/7 execution. |

**Geographic focus:** Global. Crypto trading is borderless. No region-specific restrictions at launch.

---

## 5. Market Context

### 5.1 Market Size

| Metric | Value | Source |
|--------|-------|--------|
| Crypto trading bot market | $41.6B (2024) → $154B (2033) | AInvest |
| AI crypto bot market | $1.89B (2025) → $25B (2035), 29.5% CAGR | WiseGuy Reports |
| Perpetual futures volume (2025) | $61.7T (+29% YoY) | CryptoQuant |
| DEX perp volume (2025) | $7.9T (nearly 3x prior year) | DefiLlama |
| % of crypto volume that is algorithmic | 50-60% | Kaiko Research |
| % of retail traders using automation | 45% | eToro |
| Funding rate arb APY (conservative) | 15-28% | Decentralised News |

### 5.2 Market Dynamics

- **AI agent + trading is the new battleground**: Every major exchange shipped AI/MCP trading integrations in Q1 2026 (Binance AI Pro, Gate.io AI Quant, OKX Agent Trade Kit, Kraken CLI). All are walled gardens.
- **Open-source CLI-first tools are exploding but fragmented**: Dozens of small projects (perp-cli, Raintree, Nado, CBT Framework) are building CLI+MCP tools, but none have meaningful traction or complete feature sets.
- **Delta-neutral / funding rate arb is underserved at the tool layer**: Ethena does it at the protocol level. No tool lets users set up custom funding rate arb strategies across exchanges with AI assistance.

### 5.3 Competitive Landscape

**Direct competitors (AI + trading bots):**

| Name | Pricing | AI Agent | DeFi | Key Limitation |
|------|---------|----------|------|----------------|
| Binance AI Pro | $9.99/mo | Yes (LLM-powered) | No | Binance-only, CEX-only |
| Gate.io AI Quant Workspace | Free (Gate.io account) | Yes (NL strategy) | No | Gate.io-only, CEX-only, brand new |
| Cod3x | Freemium | Yes (no-code agents) | Yes | New, limited exchange coverage |
| CBT Framework | Free (open-source) | Yes (Claude Code) | No | Tiny project (3 stars), no DeFi |
| OpenAlice (TraderAlice) | Free (open-source) | Yes (agent engine) | Partial | Complex setup, not DeFi-focused |

**Established open-source bots:**

| Name | Stars | Language | DeFi | AI Agent | Key Limitation |
|------|-------|----------|------|----------|----------------|
| Freqtrade | 30K+ | Python | No | No | Requires Python, no DeFi, no AI |
| Hummingbot | 10K+ | Python | Yes (Gateway) | Partial (MCP) | Steep learning curve, market-making focus |
| OctoBot | 4K+ | Python | Minimal | No | Smaller ecosystem |

**Key whitespace:** No tool currently combines CLI-first + AI agent for NL strategy creation + DeFi protocol support + funding rate arbitrage automation. This intersection is empty.

---

## 6. Launch Scope

### 6.1 MVP Strategies (v1.0)

| Strategy | Type | Exchanges | Complexity |
|----------|------|-----------|------------|
| Funding Rate Arbitrage | Delta-neutral: long Twilight / short Binance (or inverse) | Twilight + Binance Futures | Medium |
| Lending Yield | Deploy BTC to Twilight lending pool | Twilight only | Low |

### 6.2 Features

| Feature | MVP (v1.0) | v1.1 | Future |
|---------|------------|------|--------|
| CLI setup wizard | Yes | | |
| Template strategies (funding arb + lending) | Yes | | |
| Risk management module | Yes | | |
| Discord webhook alerts | Yes | | |
| Railway one-click deploy | Yes | | |
| Claude Code skill (monitoring) | Yes | | |
| AI custom strategy creation | | Yes | |
| Basis trade strategy | | Yes | |
| Web status dashboard | | | Yes |
| Multi-exchange expansion (Bybit, OKX) | | | Yes |
| Strategy marketplace / sharing | | | Yes |

### 6.3 Explicitly Not Building

- **Web UI for onboarding** — CLI wizard handles this
- **Backtesting engine** — out of scope for MVP; paper trading mode instead
- **HFT / low-latency execution** — cloud deployment adds 20-100ms latency; strategies target 60s+ intervals
- **Mobile app** — CLI + Discord alerts cover the use case
- **Multi-tenant SaaS** — each user runs their own instance

---

## 7. Core Product Features

### 7.1 CLI Setup Wizard (Onboarding)

Deterministic, interactive terminal flow using `inquirer`/`prompts`:

```
$ npx twilight-bots setup

Step 1/5: Twilight Wallet
  ? Create new wallet or import existing?
  → Create: generates wallet, displays mnemonic with "I have saved this" confirmation
  → Import: prompts for 24-word mnemonic

Step 2/5: Binance API Keys
  ? Binance API Key: ▌
  ? Binance API Secret: ▌
  → Verifies connection, confirms Spot + Futures enabled

Step 3/5: Discord Alerts
  ? Discord Webhook URL: ▌
  → Sends test message to verify

Step 4/5: Strategy Selection
  ? Select strategies: (space to toggle)
    ◉ Funding Rate Arbitrage
    ◉ Lending Yield

Step 5/5: Risk Profile
  ? Select profile:
    › Conservative | Moderate | Aggressive

Writing config → ~/.twilight-bots/config.json
```

Output: fully configured project ready for deployment (Railway button, `docker-compose up`, or local `docker run`).

### 7.2 Template Strategies

Ship with two production-ready strategies:

**Funding Rate Arbitrage:**
- Monitors funding rate differential between Twilight and Binance
- Opens delta-neutral position when rate exceeds threshold (covers fees + target profit)
- Closes when rate normalizes or reverses
- Handles Twilight-specific mechanics: ZkOS account funding, account rotation after close

**Lending Yield:**
- Deploys idle BTC to Twilight lending pool
- Monitors APY, rebalances based on configurable thresholds
- Withdraws if APY drops below minimum or risk conditions trigger

### 7.3 AI Custom Strategy Creation (v1.1)

Via Claude Code skill, the AI agent can:
1. Discuss strategy ideas with the user in natural language
2. Read current market conditions via `twilight-bots market` commands
3. Write a new strategy file implementing the `Strategy` interface
4. Place it in `strategies/custom/`
5. Commit and push → Railway auto-deploys

Example: "I want to go long when funding rate flips negative and close when it's above 0.03%" → agent generates `strategies/custom/funding-flip.ts`.

### 7.4 Monitoring & Management

**CLI commands:**
```
twilight-bots status           # Running strategies + PnL
twilight-bots start <strategy> # Activate a strategy
twilight-bots stop <strategy>  # Deactivate a strategy
twilight-bots config           # View/edit strategy params
twilight-bots wallet           # Balance, accounts, fund/withdraw
twilight-bots market           # Price, funding rate, orderbook
twilight-bots logs             # Tail bot logs
```

**Discord alerts** fire on: strategy start/stop, trade execution, PnL milestones, errors, liquidation risk, connection issues.

**Claude Code skill** can run any CLI command, query the REST API, format readable summaries, and diagnose issues from logs.

---

## 8. Revenue Model

**Open-source, free.** No direct revenue. This is an ecosystem growth play for Twilight Protocol:

- **Drives TVL**: Automated strategies increase capital deployed to Twilight Protocol
- **Drives volume**: Bots execute trades 24/7, increasing protocol fee revenue
- **Drives adoption**: Lowers the barrier to using Twilight, expanding the user base
- **Community flywheel**: Users sharing custom strategies → more users → more TVL/volume

---

## 9. Technical Architecture

### 9.1 Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | TypeScript / Node.js | First-class ccxt support, smaller Docker images, natural Railway fit |
| API Framework | Hono | Ultra-lightweight, multi-runtime (Node, Bun, Deno), fast |
| Exchange (Binance) | ccxt | Proven, 100+ exchanges, unified API |
| Exchange (Twilight) | relayer-cli (child_process) | Battle-tested, covers all operations |
| Database | SQLite (Drizzle ORM + better-sqlite3) | Portable — works on Railway (attached storage), VPS, or local machine. Zero config. |
| Alerts | Discord webhook | Standard for crypto community |
| Auth | Bearer token | Generated at deploy time, stored as env var |
| Deploy | Docker (Railway / VPS / local) | Flexible — Railway one-click, VPS via docker-compose, or local Docker Desktop |
| AI Interface | Claude Code skill | Natural language strategy creation + monitoring |

### 9.2 System Architecture

```
┌─────────────────────────┐       HTTPS        ┌────────────────────────────┐
│  User's Machine         │◄──────────────────►│  Railway                   │
│                         │                     │                            │
│  Claude Code + Skill    │  GET /status        │  twilight-bots service     │
│  twilight-bots CLI      │  GET /positions     │  ├─ Hono REST API          │
│                         │  POST /start        │  ├─ Strategy Engine        │
│                         │  POST /stop         │  │  ├─ Scheduler            │
│                         │  PUT /config        │  │  ├─ Loader (auto-disc.)  │
│                         │                     │  │  └─ Risk Manager         │
│  git push ─────────────►│  auto-deploy        │  ├─ relayer-cli (Twilight) │
│                         │                     │  ├─ ccxt (Binance)         │
│                         │                     │  ├─ SQLite (state)         │
│                         │                     │  └─ Discord (alerts)       │
└─────────────────────────┘                     └────────────────────────────┘
```

### 9.3 Project Structure

```
twilight-bots/
├── railway.json
├── Dockerfile
├── package.json
├── bin/
│   └── relayer-cli                    # Bundled Linux x86_64 binary
├── src/
│   ├── server.ts                      # Hono REST API
│   ├── cli/
│   │   ├── index.ts                   # CLI entry point (commander/yargs)
│   │   ├── setup.ts                   # Interactive setup wizard
│   │   ├── status.ts
│   │   ├── config.ts
│   │   └── wallet.ts
│   ├── engine/
│   │   ├── scheduler.ts               # Cron-based strategy tick loop
│   │   ├── loader.ts                  # Auto-discovers strategy files
│   │   ├── risk.ts                    # Risk management module
│   │   └── state.ts                   # SQLite-backed state
│   ├── exchanges/
│   │   ├── twilight.ts                # Wraps relayer-cli via child_process
│   │   └── binance.ts                 # Wraps ccxt with order lifecycle mgmt
│   ├── strategies/
│   │   ├── base.ts                    # Strategy interface + Context type
│   │   ├── templates/
│   │   │   ├── funding-arb.ts
│   │   │   └── lending-yield.ts
│   │   └── custom/                    # AI agent writes here
│   └── alerts/
│       └── discord.ts                 # Webhook notifications
├── skill/
│   └── twilight-bots.md               # Claude Code skill file
└── .env.example
```

### 9.4 REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Liveness check |
| GET | `/status` | All running strategies + state |
| GET | `/positions` | Open positions (Twilight + Binance) |
| GET | `/pnl` | PnL summary (per-strategy + total) |
| GET | `/history` | Trade history with filters |
| POST | `/strategies/:id/start` | Start a strategy with config |
| POST | `/strategies/:id/stop` | Gracefully stop a strategy |
| PUT | `/strategies/:id/config` | Update parameters |
| GET | `/strategies/:id/logs` | Recent structured log entries |

Bearer token auth on all endpoints except `/health`.

### 9.5 Database Schema

**Core tables:**

- `strategies` — id, name, type (template/custom), status (active/stopped/error), config (JSON text), created_at, updated_at
- `positions` — id, strategy_id, exchange, side, entry_price, size, leverage, status, opened_at, closed_at
- `trades` — id, position_id, type (open/close), price, size, fee, pnl, executed_at
- `accounts` — id, exchange, account_index, status (idle/active/locked), balance
- `alerts` — id, strategy_id, type, message, sent_at

SQLite database stored at `~/.twilight-bots/data.db` (local) or `/app/data/data.db` (Docker, mounted as persistent volume).

---

## 10. Strategy Engine

### 10.1 Strategy Interface

```typescript
export interface Strategy {
  id: string
  name: string
  description: string
  configSchema: JSONSchema          // Enables CLI validation + AI understanding

  init(config: StrategyConfig, ctx: Context): Promise<void>
  tick(): Promise<void>             // Called on configured interval
  stop(): Promise<void>             // Graceful shutdown

  status(): StrategyStatus          // Current state for monitoring
}

export interface Context {
  twilight: TwilightClient          // Wraps relayer-cli
  binance: BinanceClient            // Wraps ccxt with order lifecycle mgmt
  risk: RiskManager                 // Pre-trade risk checks
  log: Logger                       // Structured logging
  db: Database                      // SQLite state
  alert: AlertClient                // Discord notifications
}
```

### 10.2 Strategy Auto-Discovery

`loader.ts` scans `strategies/templates/` and `strategies/custom/` at boot. Any `.ts` file exporting a class implementing `Strategy` is registered with the scheduler.

### 10.3 Scheduler

Each active strategy's `tick()` runs on its configured interval (e.g., 60s for funding arb, 300s for lending yield). Strategies are independent — one failing does not affect others. The scheduler:

- Catches and logs errors per-tick (no unhandled crashes)
- Reports tick duration and success/failure to metrics
- Respects risk manager kill switch

### 10.4 Twilight-Specific Mechanics

The `TwilightClient` wrapper handles Twilight's unique requirements transparently:

- **Account rotation**: Automatically runs `zkaccount transfer --from N` after closing a trade
- **Account splitting**: Splits accounts when position size requires it
- **Nonce management**: Syncs nonces before transactions
- **SLTP unlock**: Runs `order unlock-trade` after stop-loss/take-profit settles

Strategies never interact with these mechanics directly.

### 10.5 ccxt Wrapper

The `BinanceClient` wraps ccxt with production-grade additions (informed by Freqtrade/Hummingbot patterns):

- **Order lifecycle tracking**: In-flight order management, state reconciliation with exchange
- **Retry logic**: Exponential backoff on transient failures
- **WebSocket with REST fallback**: `ccxt.pro` watch methods with REST polling as backup
- **Staleness detection**: Flags stale WebSocket data, falls back to REST
- **Per-exchange quirks**: Binance-specific configuration for precision, fee models, partial fills

---

## 11. Risk Management

Ships from day one. Non-negotiable.

| Control | Description | Default |
|---------|-------------|---------|
| **Max drawdown** | Auto-stops strategy if cumulative loss exceeds threshold | 10% (conservative), 20% (moderate), 30% (aggressive) |
| **Position size cap** | Never exceed X% of total balance per strategy | 30% (conservative), 50% (moderate), 80% (aggressive) |
| **Rate floor** | Funding arb won't enter if rate differential < fee cost + minimum profit | Dynamic based on current fees |
| **Connection watchdog** | Pauses all strategies if Twilight or Binance unreachable for >60s | 60s timeout |
| **Daily loss limit** | Stops trading for the day if daily loss exceeds threshold | 5% of balance |
| **Cooldown period** | Wait N minutes after a losing trade before re-entering | 15min (conservative), 5min (moderate), 0 (aggressive) |
| **Kill switch** | Emergency stop all strategies, persists across restarts | Manual trigger via CLI or API |

Every risk event triggers a Discord alert.

### Graceful Shutdown

On SIGTERM (Railway deploy/restart):
1. Stop accepting new ticks
2. Cancel all pending orders
3. Save current state to SQLite
4. Close WebSocket connections
5. Exit

Open positions are NOT automatically closed on restart — they persist and are picked up by the strategy on next boot.

---

## 12. Non-Functional Requirements

### 12.1 Performance

- Strategy tick latency: <5s for market data fetch + decision + order placement
- REST API response: <200ms for status/position queries
- Cloud latency budget: 20-100ms (acceptable for 60s+ strategy intervals; not targeting HFT)

### 12.2 Reliability

- Auto-restart on crash with state recovery from SQLite
- WebSocket reconnection with exponential backoff
- Strategy isolation: one strategy crashing does not affect others
- Health check endpoint for Railway monitoring

### 12.3 Security

- Bearer token auth on all API endpoints
- API keys stored as Railway encrypted environment variables, never in code/logs
- Binance API keys should be IP-restricted (recommended during setup)
- Mnemonic shown once during setup, never persisted in logs or database
- No secrets in git history

### 12.4 Observability

- Structured JSON logging (strategy, level, timestamp, metadata)
- Discord alerts for all significant events
- `/health` endpoint with uptime, active strategies, last tick times
- Trade history queryable via REST API and CLI

---

## 13. Success Metrics

### 13.1 Launch (First 30 Days)

| Metric | Target |
|--------|--------|
| Active bot instances on Railway | 50+ |
| GitHub stars | 200+ |
| Users completing setup wizard | 100+ |
| Strategies running without critical errors | 95% uptime |

### 13.2 Growth (Months 2-6)

| Metric | Target |
|--------|--------|
| Active bot instances | 500+ |
| Custom strategies created via AI agent | 100+ |
| TVL driven to Twilight Protocol | Measurable increase in protocol stats |
| Community-shared strategies | 20+ in `strategies/custom/` examples |
| Discord community members | 500+ |

### 13.3 Ecosystem Impact (Months 6+)

| Metric | Target |
|--------|--------|
| Monthly trading volume via bots | Significant % of Twilight Protocol volume |
| Contributors to repo | 20+ |
| Strategies in community marketplace | 50+ |

---

## 14. Roadmap & Phasing

### Phase 1: MVP (Weeks 1-4)

| Week | Deliverable |
|------|-------------|
| 1 | Project scaffold, CLI setup wizard, Twilight client wrapper |
| 2 | Binance client wrapper (ccxt), strategy engine (scheduler + loader + risk) |
| 3 | Funding arb template, lending yield template, Discord alerts |
| 4 | Dockerfile, Railway config, one-click deploy button, README, testing |

**MVP ships:** CLI wizard + 2 template strategies + risk management + Railway deploy + Discord alerts

### Phase 2: AI Agent (Weeks 5-8)

| Week | Deliverable |
|------|-------------|
| 5-6 | Claude Code skill file: monitoring, CLI management, market data queries |
| 7-8 | AI custom strategy creation: NL → strategy code → git push → auto-deploy |

### Phase 3: Expansion (Months 3-6)

- Basis trade template strategy
- Additional exchanges (Bybit, OKX) via ccxt
- Paper trading mode for strategy validation
- Web status dashboard
- Strategy sharing / community marketplace

---

## 15. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Users lose money, blame the bot** | High — reputation risk for Twilight Protocol | Medium | Conservative defaults, mandatory risk controls, clear disclaimers, paper trading mode |
| **Twilight Protocol instability** | High — bots fail, positions stuck | Medium | Connection watchdog pauses strategies, graceful degradation, open positions preserved across restarts |
| **AI writes flawed strategies** | High — unexpected trades or losses | Medium | Paper trading validation before live, risk module caps losses, human review step before deploy |
| **Low adoption** | Medium — effort wasted | Medium | Launch with clear value prop (funding arb APY), target existing Twilight community first, content marketing on CT |
| **ccxt breaking changes** | Medium — exchange integration breaks | Low | Pin ccxt version, test against exchange sandboxes, wrapper abstraction layer |
| **Railway platform issues** | Medium — bots go offline | Low | Graceful shutdown + state recovery, health monitoring, can migrate to any Docker host |
| **Binance API restrictions** | Medium — rate limits, geo-blocks | Low | Rate limiting in ccxt wrapper, fallback logic, plan for exchange diversification |
| **Credential exposure** | High — funds at risk | Low | CLI setup (not conversational), Railway encrypted env vars, IP-restricted API keys, never log secrets |

---

## 16. Resolved Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Language | TypeScript/Node | First-class ccxt support, smaller Docker images, natural Railway fit |
| 2 | Onboarding UX | CLI setup wizard (deterministic) | Hermes Agent pattern. Reliable, no AI unpredictability for critical setup. |
| 3 | Deployment | Docker (Railway / VPS / local) | Same image everywhere. Railway for one-click, VPS for always-on, local for testing. Agent commits → push → auto-deploy on Railway. |
| 4 | AI agent role | Custom strategy creation + monitoring + CLI management | Onboarding is deterministic CLI. AI adds value where NL is genuinely useful. |
| 5 | Binance SDK | ccxt | Battle-tested, 100+ exchanges, unified API. Wrap with order lifecycle management. |
| 6 | Twilight SDK | relayer-cli via child_process | Tried and tested. REST API exists but CLI is more reliable. |
| 7 | API auth | Bearer token | Simple, sufficient for single-user instances. Generated at deploy time. |
| 8 | Alerts | Discord webhook | Standard for crypto community. One integration covers the use case. |
| 9 | Revenue model | Free, open-source | Ecosystem growth play for Twilight Protocol. Drives TVL and volume. |
| 10 | MVP scope | Funding arb + lending yield | Two complementary strategies. Funding arb is the value prop; lending is simple to build. |
| 11 | Multi-bot architecture | One container, multiple strategies | Strategies are independent workers in a single scheduler. Simpler than multi-container. |
| 12 | Custom strategy deploy | Git push → Railway auto-deploy | Clean deploy cycle. No hot-reload risk. Agent commits, pushes, Railway rebuilds. |
| 13 | Docker necessity | Yes — minimal Dockerfile | relayer-cli binary has system dependencies. 15-line Dockerfile, deterministic builds. |

### Future Considerations (Post-Launch)

- Backtesting engine (TypeScript-native or Python sidecar)
- Web dashboard for non-CLI monitoring
- Strategy marketplace with community ratings
- Multi-exchange expansion (Bybit, OKX, Hyperliquid)
- In-loop ML features (TensorFlow.js or ONNX runtime)
- Mobile push notifications (beyond Discord)
- Multi-tenant hosted version (if demand warrants)
