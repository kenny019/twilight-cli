import type { Context, StrategyConfig } from '../types/index.js'

const SPLIT_POLL_INTERVAL_MS = 2000
const SPLIT_POLL_TIMEOUT_MS = 60_000

export async function ensureZkAccounts(
  ctx: Context,
  strategies: string[],
  configs: Record<string, StrategyConfig>,
): Promise<void> {
  const log = ctx.log

  let accounts = await ctx.twilight.walletAccounts()
  const idleAccounts = () => accounts.filter(a => a.ioType === 'Coin' && a.onChain)

  const needed: Array<{ strategy: string; amount: number }> = []

  for (const id of strategies) {
    const cfg = configs[id]
    if (!cfg) continue

    if (id === 'funding-arb') {
      const size = (cfg.positionSizeSats as number) ?? 0
      const has = idleAccounts().some(a => a.balance >= size)
      if (has) {
        log.info('funding-arb: idle account with sufficient balance exists')
      } else {
        needed.push({ strategy: id, amount: size })
      }
    } else if (id === 'lending-yield') {
      const has = idleAccounts().some(a => a.balance > 0)
      if (has) {
        log.info('lending-yield: idle account exists')
      } else {
        needed.push({ strategy: id, amount: 0 })
      }
    } else if (id === 'volume-farm') {
      const positionSize = (cfg.positionSizeSats as number) ?? 3_000
      const childSize = Math.max(positionSize * 2, 5_000)
      const minFresh = 5
      const fresh = (a: { onChain: boolean; ioType: string; txType?: string; balance: number }) =>
        a.onChain && a.ioType === 'Coin' && (a.txType === '-' || a.txType === undefined) && a.balance >= positionSize
      const freshCount = (await ctx.twilight.walletAccounts()).filter(fresh).length
      if (freshCount >= minFresh) {
        log.info('volume-farm: sufficient fresh Coin accounts available', { freshCount, minFresh })
        continue
      }

      const syncNonceA = (ctx.twilight as { syncNonce?: () => Promise<void> }).syncNonce
      if (typeof syncNonceA === 'function') {
        try { await syncNonceA.call(ctx.twilight) } catch (err) { log.warn('sync-nonce failed — continuing', { error: (err as Error).message }) }
      }

      const deficit = minFresh - freshCount
      const fundAmount = deficit * childSize
      const { sats } = await ctx.twilight.walletBalance()
      if (sats < fundAmount) {
        log.warn('volume-farm: wallet sats below required prefund amount', { sats, fundAmount })
        continue
      }

      try {
        log.info('volume-farm: funding parent ZkOS account', { fundAmount, deficit, childSize })
        const fundResult = await ctx.twilight.fund(fundAmount)
        const parentIndex = fundResult.accountIndex
        log.info('volume-farm: splitting parent into child accounts', { parentIndex, deficit, childSize })
        for (let i = 0; i < deficit; i++) {
          try {
            await ctx.twilight.split(parentIndex, [childSize])
          } catch (err) {
            log.warn('volume-farm: split failed midway', { i, error: (err as Error).message })
            break
          }
          await new Promise<void>(r => setTimeout(r, 1500))
        }

        const startedAt = Date.now()
        while (Date.now() - startedAt < SPLIT_POLL_TIMEOUT_MS) {
          await new Promise<void>(r => setTimeout(r, SPLIT_POLL_INTERVAL_MS))
          accounts = await ctx.twilight.walletAccounts()
          const usableNow = accounts.filter(fresh).length
          if (usableNow >= minFresh) {
            log.info('volume-farm: prefund complete', { usableNow })
            break
          }
        }
      } catch (err) {
        log.error('volume-farm prefund failed', { error: (err as Error).message })
      }
    } else if (id === 'market-maker') {
      const layers = Math.max(1, (cfg.layers as number) ?? 2)
      const quoteSize = (cfg.quoteSizeSats as number) ?? 10_000
      const required = layers * 2
      const usable = idleAccounts().filter(a => a.balance >= quoteSize).length
      if (usable >= required) {
        log.info('market-maker: sufficient Coin accounts available', { usable, required })
        continue
      }

      // Sync nonce before any chain-mutating operation. The method is only
      // present on the real client; mocks expose no-op or are absent.
      const syncNonce = (ctx.twilight as { syncNonce?: () => Promise<void> }).syncNonce
      if (typeof syncNonce === 'function') {
        try {
          await syncNonce.call(ctx.twilight)
        } catch (err) {
          log.warn('sync-nonce failed — continuing', { error: (err as Error).message })
        }
      }

      const deficit = required - usable
      const fundAmount = deficit * quoteSize

      const { sats } = await ctx.twilight.walletBalance()
      if (sats < fundAmount) {
        log.warn('Wallet sats below required prefund amount', { sats, fundAmount })
        continue
      }

      try {
        log.info('market-maker: funding parent ZkOS account', { fundAmount, deficit, quoteSize })
        const fundResult = await ctx.twilight.fund(fundAmount)
        const parentIndex = fundResult.accountIndex
        const balances = Array(deficit).fill(quoteSize)
        log.info('market-maker: splitting parent into quote accounts', { parentIndex, balances })
        await ctx.twilight.split(parentIndex, balances)

        // Poll until child accounts appear; non-blocking on timeout.
        const startedAt = Date.now()
        while (Date.now() - startedAt < SPLIT_POLL_TIMEOUT_MS) {
          await new Promise<void>(r => setTimeout(r, SPLIT_POLL_INTERVAL_MS))
          accounts = await ctx.twilight.walletAccounts()
          const usableNow = idleAccounts().filter(a => a.balance >= quoteSize).length
          if (usableNow >= required) {
            log.info('market-maker: prefund complete', { usableNow })
            break
          }
        }

        const finalUsable = (await ctx.twilight.walletAccounts()).filter(
          a => a.ioType === 'Coin' && a.onChain && a.balance >= quoteSize,
        ).length
        if (finalUsable < required) {
          log.warn('market-maker: child accounts did not finalize before timeout', { finalUsable, required })
        }
      } catch (err) {
        log.error('market-maker prefund failed', { error: (err as Error).message })
      }
    }
  }

  if (needed.length === 0) {
    log.info('All strategies have usable ZkOS accounts')
    return
  }

  // Refresh in case market-maker prefund consumed wallet sats above.
  const balance = await ctx.twilight.walletBalance()
  if (balance.sats === 0) {
    log.warn('Wallet has 0 sats — cannot fund ZkOS accounts. Fund the wallet first.')
    return
  }

  let remaining = balance.sats
  for (const { strategy, amount } of needed) {
    const fundAmount = amount > 0 ? Math.min(amount, remaining) : remaining
    if (fundAmount <= 0) {
      log.warn(`No sats remaining to fund account for ${strategy}`)
      continue
    }

    try {
      log.info(`Funding ZkOS account for ${strategy}`, { amount: fundAmount })
      const result = await ctx.twilight.fund(fundAmount)
      remaining -= fundAmount
      log.info(`Funded ZkOS account`, {
        strategy,
        accountIndex: result.accountIndex,
        amount: fundAmount,
      })
    } catch (err) {
      log.error(`Failed to fund ZkOS account for ${strategy}`, {
        error: (err as Error).message,
      })
    }
  }
}

