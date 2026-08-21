import 'reflect-metadata'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

/// data/photos/<sid>.jpg, archived from Sortly by cli:archive-photos --
/// see ColourVariant.photoUrl and catalog-read.service.ts. Repo-root
/// relative, same REPO_ROOT convention as archive-photos.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../')
const PHOTOS_DIR = resolve(REPO_ROOT, 'data/photos')

async function bootstrap(): Promise<void> {
  // rawBody: true exposes req.rawBody (the exact bytes Square sent)
  // alongside Nest's normal JSON-parsed req.body. The webhook signature is
  // HMAC-SHA256 over notificationUrl + rawBody -- a re-serialised JSON
  // body will not match, so this must be set before the app ever
  // receives a webhook. See square/webhook.controller.ts.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true })
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true })
  // Archived warehouse photos, so /admin/colours can show one beside its
  // family picker without proxying every image through a Nest handler.
  // Prefix matches ColourVariant.photoUrl verbatim ("data/photos/<sid>.jpg",
  // written by cli:archive-photos) so the frontend only has to prepend the
  // API origin, never rewrite the path.
  app.useStaticAssets(PHOTOS_DIR, { prefix: '/data/photos' })
  await app.listen(Number(process.env.API_PORT ?? 3001))
}

void bootstrap()
