# PRD: Adaptive AI Agent for Twilight Bots

**Status**: Draft
**Author**: @kenny019
**Date**: 2026-04-13

---

## Problem

Twilight Bots strategies are static tick loops. `funding-arb` enters when
`differential > threshold` and exits when `differential < threshold`. The
thresholds, position sizes, and timing are fixed at config time. The bot cannot:

1. **Adapt** — thresholds that work in low-vol regimes fail in high-vol.
   Funding rate dynamics shift with market structure.
2. **Learn** — losing trades carry no feedback into future decisions.
   The same bad trade repeats until a human edits config.
3. **Reason** — entry/exit logic is hardcoded `if/else`. There is no
   mechanism to incorporate qualitative signals (liquidation cascades,
   exchange outages, macro events).

This makes the system fragile to regime changes and leaves alpha on the table.

---

## Solution

Embed an **AI evaluation agent** into the strategy execution loop using
the [ax](https://github.com/ax-llm/ax) framework. The agent observes
strategy outputs, evaluates them against market context, and adapts
parameters over time. Borrow the **autonomous optimization loop** from
[pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) for
persistent state, keep/discard evaluation, and confidence scoring.

Build a **sandbox environment** to test the agent harness against
historical and simulated market data before live deployment.

---

## Architecture

### Current Flow (static)

```
Scheduler tick → Strategy.tick() → if (differential > threshold) → openTrade()
```

### Proposed Flow (agent-augmented)

```
Scheduler tick
  → Strategy.tick() gathers market snapshot
  → Agent evaluates snapshot + strategy proposal + historical context
  → Agent returns: { action, reasoning, adjustedParams }
  → Risk controls validate (unchanged)
  → Execute (or skip, per agent recommendation)
  → Log outcome to persistent journal (JSONL)
  → Agent reviews outcome on next tick (feedback loop)
```

The agent does **not** replace strategies. It wraps them as an evaluation
layer — strategies propose, the agent disposes.

---

## Workstreams

### WS-1: Agent Core (`src/agent/`)

Integrate ax as the agent framework. Define typed tools and signatures
that map to existing exchange clients and market data.

**Deliverables:**

| File | Purpose |
|------|---------|
| `src/agent/provider.ts` | ax `ai()` factory, model routing config |
| `src/agent/tools/market.ts` | `getPrice`, `getFundingRate`, `getOrderbook`, `getLendPool` as ax `fn()` tools |
| `src/agent/tools/portfolio.ts` | `getPositions`, `getPnL`, `getAccountBalances` as ax `fn()` tools |
| `src/agent/tools/strategy.ts` | `proposeEntry`, `proposeExit`, `adjustParams` as ax `fn()` tools |
| `src/agent/signatures.ts` | Typed ax signatures for evaluation, parameter tuning, regime detection |
| `src/agent/evaluator.ts` | Main `AxAgent` that evaluates strategy proposals |

**Key signatures:**

```typescript
// Evaluate whether a strategy should act on this tick
const evaluateProposal = ax(
  'proposal:string, marketSnapshot:json, recentHistory:json, journalSummary:string -> action:class "execute, skip, adjust", reasoning:string, adjustedParams:json?',
  { description: 'Evaluate a strategy trade proposal against current market context' }
);

// Detect market regime for parameter adaptation
const detectRegime = ax(
  'priceHistory:json, fundingHistory:json, volatility:number -> regime:class "trending, ranging, volatile, quiet", confidence:number, reasoning:string',
  { description: 'Classify current market regime to inform strategy parameters' }
);
```

**ax tool example:**

```typescript
const getFundingDifferential = fn('getFundingDifferential')
  .namespace('market')
  .description('Get funding rate differential between Twilight and Binance')
  .arg('pair', f.string('Trading pair'))
  .returns(f.object({
    twilightRate: f.number(),
    binanceRate: f.number(),
    differential: f.number(),
    timestamp: f.datetime(),
  }))
  .handler(async ({ pair }) => {
    const [tw, bn] = await Promise.all([
      twilightClient.fundingRate(),
      binanceClient.getFundingRate(pair),
    ]);
    return {
      twilightRate: tw,
      binanceRate: bn,
      differential: bn - tw,
      timestamp: new Date().toISOString(),
    };
  })
  .build();
```

**Design decisions:**
- Use `anthropic` provider with `claude-sonnet-4-20250514` for evaluations (cost/latency balance).
- Use `checkpointed` context policy for memory management across ticks.
- Tools expose read-only market data. Trade execution stays in strategy code, gated by risk controls. The agent advises; it does not execute.

---

### WS-2: Persistent Journal (`src/agent/journal/`)

Adopt the pi-autoresearch JSONL pattern: append-only structured log of
every evaluation, trade outcome, and parameter adjustment. This is the
agent's long-term memory that survives context resets.

**Deliverables:**

| File | Purpose |
|------|---------|
| `src/agent/journal/writer.ts` | Append entries to `data/agent-journal.jsonl` |
| `src/agent/journal/reader.ts` | Reconstruct state from JSONL on startup |
| `src/agent/journal/types.ts` | Entry schemas (evaluation, outcome, adjustment, regime) |
| `src/agent/journal/confidence.ts` | MAD-based confidence scoring (from pi-autoresearch) |

**Journal entry schema:**

```typescript
type JournalEntry =
  | {
      type: 'evaluation';
      timestamp: string;
      strategyId: string;
      proposal: object;          // what the strategy wanted to do
      action: 'execute' | 'skip' | 'adjust';
      reasoning: string;
      adjustedParams?: object;
      regime: string;
      asi: Record<string, string>; // actionable side information
    }
  | {
      type: 'outcome';
      timestamp: string;
      strategyId: string;
      entryEvalId: string;       // links to the evaluation that triggered this trade
      pnl: number;
      holdDuration: number;
      exitReason: string;
      metrics: Record<string, number>; // secondary metrics
    }
  | {
      type: 'adjustment';
      timestamp: string;
      strategyId: string;
      previousParams: object;
      newParams: object;
      reasoning: string;
      confidence: number;        // MAD-based confidence score
    };
```

**Confidence scoring** (adapted from pi-autoresearch):
- After 5+ outcomes, compute MAD of PnL series as noise floor.
- `confidence = |mean_pnl_change| / MAD`
- \>=2.0: parameter change is likely real improvement → keep.
- 1.0–2.0: marginal, needs more data.
- <1.0: within noise, revert parameter change.

**ASI (Actionable Side Information):**
Every evaluation carries free-form key/value metadata that survives
context resets. Minimum fields: `hypothesis`, `market_regime`,
`entry_trigger`. On failed trades, also: `exit_reason`,
`what_went_wrong`, `next_action_hint`.

---

### WS-3: Strategy Integration (`src/strategies/`)

Modify the Strategy interface and existing strategies to support agent
evaluation. The change is minimal: strategies gain an optional
`evaluateWithAgent` hook in the tick loop.

**Changes to existing files:**

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `AgentContext` to `Context`, add `AgentEvaluation` type |
| `src/engine/scheduler.ts` | Insert agent evaluation step between proposal and execution |
| `src/strategies/templates/funding-arb.ts` | Extract proposal logic into `propose()` method; execution in `execute()` |
| `src/strategies/templates/lending-yield.ts` | Same refactor |

**Updated strategy interface:**

```typescript
interface Strategy {
  // ... existing methods ...
  propose?(ctx: Context): Promise<StrategyProposal | null>;  // NEW
  execute?(ctx: Context, evaluation: AgentEvaluation): Promise<void>;  // NEW
}
```

**Updated tick loop (scheduler.ts):**

```typescript
async function tick(strategy: Strategy, ctx: Context) {
  // 1. Strategy proposes action (or null = no action)
  const proposal = await strategy.propose?.(ctx);
  if (!proposal) return;

  // 2. Agent evaluates proposal (if agent enabled)
  let evaluation: AgentEvaluation = { action: 'execute', reasoning: 'agent disabled' };
  if (ctx.agent) {
    evaluation = await ctx.agent.evaluate(proposal, ctx);
    journal.append({ type: 'evaluation', ...evaluation });
    if (evaluation.action === 'skip') return;
  }

  // 3. Risk controls (unchanged)
  const riskCheck = await ctx.risk.checkPreTrade(...);
  if (!riskCheck.allowed) return;

  // 4. Execute (with optional parameter adjustments)
  await strategy.execute?.(ctx, evaluation);
}
```

**Backward compatibility:** If `propose()` is not defined, fall back to
existing `tick()` method. Agent evaluation is opt-in per strategy.

---

### WS-4: Sandbox Environment (`src/sandbox/`)

A testing harness that replays historical market data through the agent
+ strategy pipeline without executing real trades.

**Deliverables:**

| File | Purpose |
|------|---------|
| `src/sandbox/runner.ts` | Orchestrates sandbox runs |
| `src/sandbox/market-replay.ts` | Feeds historical data as mock exchange responses |
| `src/sandbox/data-loader.ts` | Loads CSV/JSON market data files |
| `src/sandbox/mock-exchanges.ts` | Mock TwilightClient and BinanceClient that return replayed data |
| `src/sandbox/reporter.ts` | PnL curves, win rate, Sharpe, drawdown stats |
| `src/sandbox/cli.ts` | CLI command: `twilight-bots sandbox --data ./data/btc-2025.csv` |
| `data/samples/` | Sample market data files for testing |

**Sandbox runner flow:**

```
1. Load market data file (timestamp, price, fundingRate, volume, ...)
2. Create mock exchange clients that serve data by timestamp
3. Initialize agent + strategy with sandbox context
4. For each timestamp in data:
   a. Advance mock clock
   b. Run strategy.propose() with mock market data
   c. Run agent.evaluate() with real LLM call (or cached)
   d. Simulate execution (track virtual positions)
   e. Log to sandbox journal
5. Generate report: PnL curve, metrics, agent decision log
```

**Mock exchange interface:**

```typescript
class SandboxTwilightClient implements TwilightClient {
  constructor(private data: MarketDataPoint[], private clock: SandboxClock) {}

  async marketPrice(): Promise<number> {
    return this.clock.current().price;
  }

  async fundingRate(): Promise<number> {
    return this.clock.current().twilightFundingRate;
  }
  // ... all methods return data from current clock position
}
```

**Data format** (CSV):

```csv
timestamp,price,twilightFundingRate,binanceFundingRate,volume,volatility
2025-01-01T00:00:00Z,42150.50,0.0,0.0012,1500000,0.015
2025-01-01T01:00:00Z,42200.00,0.0,0.0015,1200000,0.018
```

**LLM cost control in sandbox:**
- Cache agent responses by input hash to avoid redundant LLM calls during iterative testing.
- Support `--dry-run` flag that skips LLM calls and uses a deterministic mock evaluator.
- Support `--cache-dir ./cache` for persistent response caching across runs.

---

### WS-5: Configuration & Observability

**New config fields** (twilight-bots.config.json):

```json
{
  "agent": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "sk-...",
    "evaluationBudget": {
      "maxCallsPerHour": 60,
      "maxTokensPerDay": 500000
    },
    "journalPath": "./data/agent-journal.jsonl",
    "confidenceThreshold": 2.0
  }
}
```

**Observability:**
- ax's built-in OpenTelemetry metrics (token usage, latency, retries).
- Journal entries double as audit log — every agent decision is traceable.
- Discord alerts for agent regime changes and parameter adjustments.
- New API endpoints:
  - `GET /agent/status` — agent state, recent evaluations, regime.
  - `GET /agent/journal?limit=50` — recent journal entries.
  - `POST /agent/override` — human override to force-adjust parameters.

---

## Phasing

| Phase | Scope | Depends On |
|-------|-------|------------|
| **Phase 1** | WS-4 (Sandbox) + WS-1 (Agent Core — tools & signatures only) | Nothing |
| **Phase 2** | WS-2 (Journal) + WS-3 (Strategy Integration) | Phase 1 |
| **Phase 3** | WS-5 (Config & Observability) + live testing | Phase 2 |

Phase 1 is designed to be testable in isolation — the sandbox + agent
core can run against sample data without touching live strategies.

---

## Risks

| Risk | Mitigation |
|------|------------|
| LLM latency delays tick execution | Agent evaluation is async with timeout. If LLM doesn't respond in 10s, fall back to strategy's static logic. |
| LLM hallucinated parameters cause bad trades | Agent advises, risk controls enforce. Position size caps, drawdown limits, and kill switch remain unchanged. |
| LLM cost spirals with frequent ticks | Budget caps in config (`maxCallsPerHour`, `maxTokensPerDay`). Degrade to cached regime classification when budget exceeded. |
| Agent overrides good strategy decisions | Confidence scoring gates parameter changes. Sub-2.0 confidence adjustments are logged but not applied without human approval. |
| Context window exhaustion on long sessions | Checkpointed context policy (ax built-in) + JSONL journal for persistent memory across resets. |

---

## Non-Goals

- The agent does **not** replace strategies. It evaluates and tunes them.
- The agent does **not** execute trades directly. Execution remains in strategy code, gated by risk controls.
- No new exchange integrations in this refactor.
- No UI/dashboard — API + Discord alerts are sufficient.
- No backtesting engine (the sandbox is forward-simulation with historical data, not a full backtest framework with slippage/fill modeling).

---

## Success Criteria

1. Sandbox can replay 30 days of historical data through agent + funding-arb strategy and produce a PnL report.
2. Agent correctly identifies regime changes (volatile vs quiet) with >70% accuracy on labeled test data.
3. Agent-adjusted parameters outperform static parameters by >15% on Sharpe ratio in sandbox testing.
4. Zero increase in live trade execution latency (agent runs async, does not block order flow).
5. Full audit trail — every agent decision is logged to journal with reasoning.

---

## Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `@ax-llm/ax` | latest | Agent framework (signatures, tools, flows, evaluation) |
| `@ax-llm/ax-tools` | latest | JS runtime for agent execution |
| Anthropic API key | — | LLM provider for agent evaluations |
