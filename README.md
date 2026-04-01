# Twilight Bots

CLI-first trading bot platform for [Twilight Protocol](https://twilight.finance) and Binance. Run automated strategies, deploy to Railway with one click.

Ships with two template strategies (funding rate arbitrage + lending yield), 7 risk controls, Discord alerts, and a REST API for remote management.

## Quick Start

```bash
# Install dependencies
npm install

# Run the interactive setup wizard
npx twilight-bots setup

# Start the bot locally
npm run dev
```

The setup wizard walks through 5 steps:

1. **Twilight Wallet** -- create a new wallet or import an existing mnemonic
2. **Binance API Keys** -- API key + secret (Spot + Futures permissions required)
3. **Discord Alerts** -- webhook URL for trade notifications
4. **Strategy Selection** -- choose from `funding-arb` and `lending-yield`
5. **Risk Profile** -- conservative, moderate, or aggressive

Output: `twilight-bots.config.json` with all settings + an auto-generated Bearer token.

## Strategies

### Funding Rate Arbitrage

Delta-neutral strategy that exploits funding rate differentials between Twilight (0% funding) and Binance.

- Opens long on Twilight + short on Binance when the rate differential exceeds the entry threshold
- Closes both legs when the differential drops below the exit threshold
- Handles ZkOS account funding and auto-rotation after close

| Parameter | Description |
|-----------|-------------|
| `entryThreshold` | Minimum rate differential to open positions |
| `exitThreshold` | Rate differential below which positions are closed |
| `positionSizeSats` | Position size in satoshis |
| `checkIntervalMs` | Polling interval in milliseconds |

### Lending Yield

Deploys idle BTC to Twilight's lending pool for yield.

- Opens lend positions when APY exceeds the minimum threshold
- Withdraws when APY drops below the threshold
- Monitors and rebalances based on configurable thresholds

| Parameter | Description |
|-----------|-------------|
| `minApyThreshold` | Minimum APY (%) required to open a lend position |
| `rebalanceThreshold` | APY delta that triggers rebalance |
| `checkIntervalMs` | Polling interval in milliseconds |

## Risk Management

All risk controls are active from day one. Profile defaults:

| Control | Conservative | Moderate | Aggressive |
|---------|-------------|----------|------------|
| Max drawdown | 10% | 20% | 30% |
| Position size cap | 30% | 50% | 80% |
| Cooldown after loss | 15 min | 5 min | 0 min |
| Daily loss limit | 5% | 5% | 5% |

Additional controls:
- **Connection watchdog** -- pauses strategies if an exchange is unreachable
- **Kill switch** -- emergency stop all strategies, persists across restarts
- **Rate floor** -- funding arb won't enter if rate < fee cost + minimum profit

## Deployment

### Railway (recommended)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

Set these environment variables in Railway:

```
TWILIGHT_WALLET_ID=your_wallet_id
TWILIGHT_PASSWORD=your_wallet_password
BINANCE_API_KEY=your_api_key
BINANCE_API_SECRET=your_api_secret
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
BEARER_TOKEN=your_secret_token
PORT=3000
```

### Docker Compose (VPS / local)

```bash
cp .env.example .env
# Edit .env with your credentials

docker compose up -d
```

Data is persisted in a Docker volume at `/app/data`.

### Local Development

```bash
npm install
npm run dev      # Starts with tsx (hot reload)
npm run build    # Compile TypeScript
npm start        # Run compiled output
```

## CLI Commands

```bash
twilight-bots setup              # Interactive setup wizard
twilight-bots status             # Running strategies + PnL
twilight-bots start <strategy>   # Start a strategy
twilight-bots stop <strategy>    # Stop a strategy
twilight-bots config             # View/edit strategy parameters
twilight-bots wallet             # Balance, accounts, fund/withdraw
twilight-bots market             # Price, funding rate, orderbook
twilight-bots logs               # Tail bot logs
```

Management commands connect to the REST API, so the bot can be running locally or on Railway.

## REST API

All endpoints except `/health` require a `Bearer` token in the `Authorization` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Liveness check (no auth) |
| GET | `/status` | Running strategies + state |
| GET | `/positions` | Open positions |
| GET | `/pnl` | PnL summary (per-strategy + total) |
| GET | `/history` | Trade history (supports `?strategyId=` and `?limit=`) |
| POST | `/strategies/:id/start` | Start a strategy |
| POST | `/strategies/:id/stop` | Stop a strategy |
| PUT | `/strategies/:id/config` | Update strategy parameters |
| GET | `/strategies/:id/logs` | Recent log entries |

Example:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/status
```

## Custom Strategies

Create a new file in `src/strategies/custom/` that implements the `Strategy` interface:

```typescript
import type { Strategy, StrategyConfig, StrategyInfo, Context } from '../../types/index.js'

export class MyStrategy implements Strategy {
  id = 'my-strategy'
  name = 'My Custom Strategy'
  description = 'Does something clever'
  configSchema = { type: 'object', properties: { /* ... */ } }

  private ctx!: Context

  async init(config: StrategyConfig, ctx: Context) {
    this.ctx = ctx
  }

  async tick() {
    const price = await this.ctx.twilight.marketPrice()
    const rate = await this.ctx.binance.getFundingRate()
    // Your strategy logic here
  }

  async stop() { /* cleanup */ }
  status(): StrategyInfo { /* return current state */ }
}
```

The strategy engine auto-discovers files in `strategies/templates/` and `strategies/custom/` at boot.

## Architecture

```
twilight-bots/
├── src/
│   ├── server.ts              # Hono REST API
│   ├── cli/                   # CLI (commander + inquirer setup wizard)
│   ├── engine/
│   │   ├── scheduler.ts       # Cron-based tick loop with strategy isolation
│   │   ├── loader.ts          # Auto-discovers strategy files
│   │   └── risk.ts            # 7 risk controls
│   ├── exchanges/
│   │   ├── twilight.ts        # Wraps relayer-cli via execFile
│   │   └── binance.ts         # Wraps ccxt (USD-M Futures)
│   ├── strategies/
│   │   ├── templates/         # Funding arb + lending yield
│   │   └── custom/            # Your strategies go here
│   ├── alerts/
│   │   └── discord.ts         # Webhook notifications with rate limiting
│   ├── db/                    # SQLite via Drizzle ORM
│   └── types/                 # All shared interfaces
├── Dockerfile                 # Multi-stage Node 20 Alpine
├── docker-compose.yml         # Local/VPS deployment
├── railway.json               # One-click Railway deploy
└── .env.example               # Environment variable reference
```

## Testing

```bash
npm test              # Run all 175 tests
npm run test:watch    # Watch mode
npm run typecheck     # TypeScript strict mode check
```

## License

Open source. Free to use, modify, and distribute.
