---
name: twilight-strategies
description: |
  Query and run trading strategies on the Twilight Strategy API. Use when the
  user asks about hedging, funding arbitrage, delta-neutral strategies, or
  wants to simulate trades across Twilight, Binance, and Bybit.
---

# Twilight Strategy API

Query live trading strategies, market data, and simulate trade impact using the
Twilight Strategy API.

## Base URL

```
http://134.199.214.129:3000
```

## Authentication

All endpoints (except `/api/health`) require an API key:

```
Header: x-api-key: 123hEll@he
# or query param: ?api_key=123hEll@he
```

## Endpoints

### Health Check
```bash
curl http://134.199.214.129:3000/api/health
```

### Live Market Data
```bash
curl -H "x-api-key: 123hEll@he" http://134.199.214.129:3000/api/market
```
Returns: live prices, funding rates, spreads, pool skew.

### All Strategies (with live calculations)
```bash
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies"
```

### Filter Strategies
```bash
# By category
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies?category=Delta-Neutral"

# By risk level
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies?risk=LOW"

# Only profitable
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies?profitable=true"

# Minimum APY threshold
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies?minApy=50"

# Limit results
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies?profitable=true&limit=5"
```

### Single Strategy by ID
```bash
curl -H "x-api-key: 123hEll@he" "http://134.199.214.129:3000/api/strategies/:id"
```

### Run Custom Strategy
```bash
curl -X POST -H "x-api-key: 123hEll@he" -H "Content-Type: application/json" \
  -d '{"twilightPosition":"SHORT","twilightSize":200,"twilightLeverage":10,"binancePosition":"LONG","binanceSize":200,"binanceLeverage":10}' \
  http://134.199.214.129:3000/api/strategies/run
```

### Simulate Trade Impact on Pool
```bash
curl -X POST -H "x-api-key: 123hEll@he" -H "Content-Type: application/json" \
  -d '{"side":"LONG","size":500,"leverage":10}' \
  http://134.199.214.129:3000/api/impact
```

### List Categories
```bash
curl -H "x-api-key: 123hEll@he" http://134.199.214.129:3000/api/categories
```

### Pool Configuration
```bash
# Get current pool config
curl -H "x-api-key: 123hEll@he" http://134.199.214.129:3000/api/pool

# Update pool config
curl -X POST -H "x-api-key: 123hEll@he" -H "Content-Type: application/json" \
  -d '{"tvl":500,"longSize":300,"shortSize":200}' \
  http://134.199.214.129:3000/api/pool
```

## Strategy Categories

- **Directional**: Pure long/short on a single venue
- **Delta-Neutral**: Hedged positions across venues (long one, short other)
- **Funding Arbitrage**: Exploit funding rate differentials
- **Inverse Perp Arb**: Twilight vs Bybit inverse perpetuals (both BTC-margined)
- **Funding Harvest**: Earn funding when pool skew favors your side
- **Dual Arbitrage**: Both sides pay you when conditions align
- **Conservative**: Low leverage for safety
- **Stablecoin**: Create stable USD value by shorting with spot BTC

## Key Insight

Twilight charges **0% funding** and **0% trading fees**. Every strategy exploits
this against Binance (0.04% taker, 8h funding) and Bybit (0.055% taker).

## Infrastructure

- Runtime: Node.js 20 + Express
- Process Manager: pm2
- Data: Live WebSocket feeds from Binance (futures + mark price) and Bybit inverse
- 38 strategies across 9 categories generated in real-time
