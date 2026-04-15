import { appendFileSync, writeFileSync } from 'node:fs'
import type { JournalEntry } from '../../types/agent.js'

export class JournalWriter {
  private buffer: string[] = []
  private buffered: boolean

  constructor(
    private path: string,
    opts?: { buffered?: boolean },
  ) {
    this.buffered = opts?.buffered ?? false
  }

  append(entry: JournalEntry): void {
    const line = JSON.stringify(entry) + '\n'
    if (this.buffered) {
      this.buffer.push(line)
    } else {
      appendFileSync(this.path, line, 'utf-8')
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return
    writeFileSync(this.path, this.buffer.join(''), { flag: 'a', encoding: 'utf-8' })
    this.buffer = []
  }
}
