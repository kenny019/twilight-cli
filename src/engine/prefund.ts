import type { Context, StrategyConfig } from '../types/index.js'

export async function ensureZkAccounts(
  ctx: Context,
  strategies: string[],
  configs: Record<string, StrategyConfig>,
): Promise<void> {
  const log = ctx.log

  const accounts = await ctx.twilight.walletAccounts()
  const idleAccounts = accounts.filter(a => a.ioType === 'Coin')

  // Check if each enabled strategy already has a usable idle account
  const needed: Array<{ strategy: string; amount: number }> = []

  for (const id of strategies) {
    const cfg = configs[id]
    if (!cfg) continue

    if (id === 'funding-arb') {
      const size = (cfg.positionSizeSats as number) ?? 0
      const has = idleAccounts.some(a => a.balance >= size)
      if (has) {
        log.info('funding-arb: idle account with sufficient balance exists')
      } else {
        needed.push({ strategy: id, amount: size })
      }
    } else if (id === 'lending-yield') {
      const has = idleAccounts.some(a => a.balance > 0)
      if (has) {
        log.info('lending-yield: idle account exists')
      } else {
        needed.push({ strategy: id, amount: 0 }) // 0 = use remaining balance
      }
    }
  }

  if (needed.length === 0) {
    log.info('All strategies have usable ZkOS accounts')
    return
  }

  const { sats } = await ctx.twilight.walletBalance()
  if (sats === 0) {
    log.warn('Wallet has 0 sats — cannot fund ZkOS accounts. Fund the wallet first.')
    return
  }

  let remaining = sats
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
