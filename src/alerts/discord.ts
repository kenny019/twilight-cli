import type { AlertClient, AlertMessage, RiskCheckResult } from '../types/index.js'

// Max concurrent in-flight requests — keeps us within Discord's 30/min limit
// without blocking the queue on a hard time window.
const MAX_CONCURRENT = 30

interface QueueEntry {
  message: AlertMessage
  resolve: (value: boolean) => void
}

export class DiscordAlertClient implements AlertClient {
  private readonly webhookUrl: string
  private readonly queue: QueueEntry[] = []
  private inFlight = 0

  constructor(webhookUrl: string) {
    if (!webhookUrl) throw new Error('Discord webhook URL must not be empty')
    try {
      const parsed = new URL(webhookUrl)
      if (parsed.protocol !== 'https:') throw new Error('Discord webhook URL must use https')
    } catch {
      throw new Error(`Invalid Discord webhook URL: ${webhookUrl}`)
    }
    this.webhookUrl = webhookUrl
  }

  send(message: AlertMessage): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ message, resolve })
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0 && this.inFlight < MAX_CONCURRENT) {
      const entry = this.queue.shift()!
      this.inFlight++
      this.dispatch(entry.message).then((result) => {
        entry.resolve(result)
        this.inFlight--
        // Process any messages that were waiting for a slot
        this.drain()
      })
    }
  }

  private async dispatch(message: AlertMessage): Promise<boolean> {
    const embed: Record<string, unknown> = {
      title: message.title,
      description: message.description,
    }
    if (message.fields !== undefined) embed.fields = message.fields
    if (message.color !== undefined) embed.color = message.color

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async sendTradeAlert(
    strategyId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    const fields = Object.entries(details).map(([name, value]) => ({
      name,
      value: String(value),
      inline: true,
    }))
    return this.send({
      type: 'trade',
      title: `Trade Alert [${strategyId}]: ${action}`,
      description: `Action **${action}** executed for strategy \`${strategyId}\``,
      fields,
      color: 0x00ff00,
    })
  }

  async sendErrorAlert(strategyId: string, error: Error): Promise<boolean> {
    return this.send({
      type: 'error',
      title: `Error Alert [${strategyId}]`,
      description: error.message,
      fields: [{ name: 'Stack', value: error.stack ?? 'N/A', inline: false }],
      color: 0xff0000,
    })
  }

  async sendRiskAlert(strategyId: string, check: RiskCheckResult): Promise<boolean> {
    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      { name: 'Allowed', value: String(check.allowed), inline: true },
    ]
    if (check.control) fields.push({ name: 'Control', value: check.control, inline: true })
    if (check.reason) fields.push({ name: 'Reason', value: check.reason, inline: false })

    return this.send({
      type: 'risk',
      title: `Risk Alert [${strategyId}]`,
      description: check.reason ?? 'Risk check triggered',
      fields,
      color: 0xffff00,
    })
  }
}
