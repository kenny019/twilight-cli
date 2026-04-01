// Stub — WS-8 will implement
import { Hono } from 'hono'

export interface AppDeps {
  bearerToken: string
  scheduler: any
  db: any
  startTime: number
}

export function createApp(_deps: AppDeps) {
  const app = new Hono()
  // WS-8 will add all routes
  return app
}
