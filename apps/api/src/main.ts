import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap(): Promise<void> {
  // rawBody: true exposes req.rawBody (the exact bytes Square sent)
  // alongside Nest's normal JSON-parsed req.body. The webhook signature is
  // HMAC-SHA256 over notificationUrl + rawBody -- a re-serialised JSON
  // body will not match, so this must be set before the app ever
  // receives a webhook. See square/webhook.controller.ts.
  const app = await NestFactory.create(AppModule, { rawBody: true })
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true })
  await app.listen(Number(process.env.API_PORT ?? 3001))
}

void bootstrap()
