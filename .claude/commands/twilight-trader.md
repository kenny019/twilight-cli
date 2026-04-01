---
name: twilight-trader
description: |
  Manage wallets, fund ZkOS accounts, and open/close leveraged perpetual trades
  on Twilight Protocol using the relayer-cli. Trigger when the user asks to
  trade, open a position, check balances, query market data, or manage their
  Twilight wallet.
---

# Twilight Trading Agent

Binary: `./target/release/relayer-cli`
Full CLI reference: `.claude/references/relayer-cli.md`

## Environment

`.env` is loaded automatically. Required variables:

| Variable | Mainnet | Testnet |
|---|---|---|
| `NYKS_LCD_BASE_URL` | `https://lcd.twilight.org` | `https://lcd.twilight.rest` |
| `NYKS_RPC_BASE_URL` | `https://rpc.twilight.org` | `https://rpc.twilight.rest` |
| `ZKOS_SERVER_URL` | `https://zkserver.twilight.org` | `https://nykschain.twilight.rest/zkos` |
| `RELAYER_API_RPC_SERVER_URL` | `https://api.ephemeral.fi/api` | `https://relayer.twilight.rest/api` |
| `RELAYER_PROGRAM_JSON_PATH` | `./relayerprogram.json` | `./relayerprogram.json` |
| `CHAIN_ID` | `nyks` | `nyks` |
| `NETWORK_TYPE` | `mainnet` | `testnet` |
| `FAUCET_BASE_URL` | — | `https://faucet-rpc.twilight.rest` |

Optional: `NYKS_WALLET_ID`, `NYKS_WALLET_PASSPHRASE` (omit to prompt interactively).

## Build (if binary missing)

```bash
# macOS (requires libpq from homebrew)
RUSTFLAGS="-L /opt/homebrew/opt/libpq/lib" cargo build --release --bin relayer-cli

# Linux
cargo build --release --bin relayer-cli

# PostgreSQL backend
cargo build --release --bin relayer-cli --no-default-features --features postgresql
```

TTY note: mnemonics print to `/dev/tty`; falls back to stderr in headless environments.

## Credential Resolution

`--wallet-id` → session cache → `NYKS_WALLET_ID` → error
`--password` → session cache → `NYKS_WALLET_PASSPHRASE` → none

Run `wallet unlock` once to cache credentials for the session.

## Wallet Commands

```bash
# Create (prints mnemonic ONCE — save it)
relayer-cli wallet create --wallet-id <ID> --password <PASS>
relayer-cli wallet create --btc-address bc1q...  # use existing BTC address

# Import from mnemonic (prompts securely if --mnemonic omitted)
relayer-cli wallet import --mnemonic "<24 words>" --wallet-id <ID> --password <PASS>

# Balance & accounts
relayer-cli wallet balance
relayer-cli wallet accounts                      # list ZkOS accounts
relayer-cli wallet accounts --on-chain-only      # hide off-chain
relayer-cli wallet info                          # no chain calls

# Session & management
relayer-cli wallet list                          # all stored wallets
relayer-cli wallet unlock                        # cache creds for session
relayer-cli wallet lock                          # clear session cache

# Backup & restore
relayer-cli wallet backup --output backup.json
relayer-cli wallet restore --input backup.json
relayer-cli wallet export --output wallet.json

# Maintenance
relayer-cli wallet update-btc-address --btc-address bc1q...
relayer-cli wallet sync-nonce
relayer-cli wallet change-password               # always prompts via TTY
```

## ZkOS Account Commands

Amounts accept `--amount` (sats), `--amount-mbtc`, or `--amount-btc`.

```bash
# Fund a new trading account from on-chain sats
relayer-cli zkaccount fund --amount 10000
relayer-cli zkaccount fund --amount-mbtc 1.0
relayer-cli zkaccount fund --amount-btc 0.001

# Withdraw back to on-chain wallet
relayer-cli zkaccount withdraw --account-index 0 --amount 5000

# Transfer (rotate) to a fresh account
relayer-cli zkaccount transfer --from 0

# Split one account into multiple
relayer-cli zkaccount split --from 0 --balances "2000,3000,5000"
relayer-cli zkaccount split --from 0 --balances-mbtc "0.02,0.03"
```

## Order Commands

```bash
# Open — market (default)
relayer-cli order open-trade --account-index 0 --side LONG --entry-price 65000 --leverage 5

# Open — limit
relayer-cli order open-trade --account-index 1 --order-type LIMIT --side SHORT --entry-price 70000 --leverage 5

# Close — market
relayer-cli order close-trade --account-index 0

# Close — with stop-loss / take-profit (SLTP)
relayer-cli order close-trade --account-index 0 --stop-loss 60000 --take-profit 75000

# Cancel pending order
relayer-cli order cancel-trade --account-index 0

# Unlock after SLTP settles (reclaims account)
relayer-cli order unlock-trade --account-index 0

# Query & history
relayer-cli order query-trade --account-index 0
relayer-cli order history-trade --account-index 0
relayer-cli order funding-history --account-index 0
relayer-cli order account-summary [--from DATE --to DATE]
relayer-cli order tx-hashes --id <REQID> [--by request|account|tx] [--status FILLED]

# Lending
relayer-cli order open-lend --account-index 0
relayer-cli order close-lend --account-index 0
relayer-cli order query-lend --account-index 0
relayer-cli order history-lend --account-index 0
```

**`--no-wait`**: add to `open-trade` or `close-trade` to return after relayer confirms, skipping chain sync (~2.8s vs ~5s).

Constraints: entire account balance used as margin. Check `market market-stats` for max position size (20% of pool equity); split first if needed.

## Market Data

No wallet needed.

```bash
relayer-cli market price
relayer-cli market orderbook
relayer-cli market funding-rate
relayer-cli market fee-rate
relayer-cli market market-stats
relayer-cli market open-interest
relayer-cli market position-size
relayer-cli market recent-trades
relayer-cli market server-time

# Lending pool
relayer-cli market lend-pool
relayer-cli market pool-share-value
relayer-cli market last-day-apy
relayer-cli market apy-chart [--range 7d|30d|1y] [--step 1h|1d]

# Historical
relayer-cli market candles --since <DATE> --interval 1m|5m|15m|30m|1h|4h|8h|12h|1d
relayer-cli market history-price --from <DATE> --to <DATE>
relayer-cli market history-funding --from <DATE> --to <DATE>
relayer-cli market history-fees --from <DATE> --to <DATE>
```

## Portfolio

```bash
relayer-cli portfolio summary
relayer-cli portfolio balances [--unit sats|mbtc|btc]
relayer-cli portfolio risks
```

## History (requires DB)

```bash
relayer-cli history orders [--limit N] [--offset N]
relayer-cli history transfers [--limit N] [--offset N]
```

## Typical Trade Flow

```bash
# 1. Check market
relayer-cli market price
relayer-cli market market-stats      # check max position size (20% of pool equity)

# 2. Fund
relayer-cli wallet balance
relayer-cli zkaccount fund --amount 5000   # sats; also --amount-mbtc, --amount-btc

# 3. Open trade
relayer-cli order open-trade \
  --account-index 0 \
  --side LONG \
  --entry-price 65000 \
  --leverage 5

# 4. Monitor
relayer-cli portfolio summary

# 5. Close
relayer-cli order close-trade --account-index 0

# 6. Rotate before reusing account (required)
relayer-cli zkaccount transfer --from 0
```

Fast variant: add `--no-wait` to steps 3 and 5 (~2.8s open, ~5s close with deferred chain sync).

## Key Concepts

- **Inverse perpetuals**: margin + PnL denominated in sats (BTC)
- **Full balance per order**: entire ZkOS account committed as margin — split first if needed
- **Account states**: Coin (idle) → Memo (order active)
- **Must rotate after close**: `zkaccount transfer --from <N>` or withdraw + re-fund. Exception: cancelled limit orders (never filled) can reuse the same account
- **SLTP orders**: after stop-loss/take-profit settles, run `order unlock-trade --account-index <N>` to reclaim the account
- **Max leverage**: 50x; **max position**: 20% of pool equity
- **Fees**: 4% fill + 4% settle (market); 2% fill + 2% settle (limit)
- **`--json`**: all commands support JSON output for scripting

## Ephemeral REST API (alternative to CLI)

For programmatic access without the CLI:

- **Public**: `POST https://api.ephemeral.fi/api` (market data, submit orders)
- **Private**: `POST https://relayer.twilight.rest/api/private` (authenticated order management)
- **Register**: `POST https://relayer.twilight.rest/register` (get api_key + api_secret)

Authentication for private endpoints requires headers:
- `relayer-api-key`: your api_key
- `signature`: HMAC-SHA256(request_body, api_secret)
- `datetime`: unix timestamp in milliseconds

For detailed flag documentation, read `.claude/references/relayer-cli.md`.
