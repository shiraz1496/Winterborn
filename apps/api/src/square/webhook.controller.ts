import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  UnauthorizedException,
  BadRequestException,
  type RawBodyRequest,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'

const UNIQUE_VIOLATION = 'P2002'

/**
 * Minimal shape we need off the request. Not importing `express`'s own
 * `Request` type here -- this package has no `@types/express` dependency,
 * and `RawBodyRequest<T>` is a plain intersection type, so this narrow
 * interface is enough to type-check `req.body` / `req.rawBody` safely.
 */
interface InboundWebhookRequest {
  body?: unknown
  rawBody?: Buffer
}

/**
 * Verifies Square's webhook signature: HMAC-SHA256 over
 * `notificationUrl + rawBody`, base64-encoded, compared in constant time
 * (spec §7.1). `rawBody` must be the exact bytes Square sent -- a
 * re-serialised JSON body will not match, which is why this route needs
 * the raw request body wired up in main.ts before anything else here can
 * work (see main.ts's `rawBody: true`).
 */
export function verifySquareSignature(rawBody: string, header: string, key: string, notificationUrl: string): boolean {
  const expected = createHmac('sha256', key).update(notificationUrl + rawBody).digest('base64')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const givenBuf = Buffer.from(header, 'utf8')
  if (expectedBuf.length !== givenBuf.length) return false
  return timingSafeEqual(expectedBuf, givenBuf)
}

/**
 * The webhook endpoint does three things and nothing else (spec §7.1):
 * verify the signature, insert the raw payload into `SquareInboxEvent`,
 * return 200. No parsing beyond reading the event id/type for storage, no
 * ledger write, no Square API call inline -- that all happens later, in
 * `InboxWorker`, off the request path.
 */
@Controller('square')
export class WebhookController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<InboundWebhookRequest>,
    @Headers('x-square-hmacsha256-signature') signature?: string,
  ): Promise<{ ok: true }> {
    const rawBody = req.rawBody
    if (!rawBody) {
      // Should be unreachable once main.ts's rawBody wiring is correct;
      // fail loudly rather than silently trusting an unverifiable body.
      throw new BadRequestException('raw body unavailable')
    }

    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? ''
    const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}/square/webhook`

    if (!signature || !key || !verifySquareSignature(rawBody.toString('utf8'), signature, key, notificationUrl)) {
      throw new UnauthorizedException('invalid Square webhook signature')
    }

    const body = req.body as { event_id?: string; type?: string } | undefined
    const squareEventId = body?.event_id
    if (!squareEventId) throw new BadRequestException('missing event_id')

    try {
      await this.prisma.squareInboxEvent.create({
        data: { squareEventId, eventType: body?.type ?? 'unknown', payload: body as Prisma.InputJsonValue },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        // Square re-delivered an event we already have. Still 200, still
        // exactly one row -- redelivery is expected, not an error.
        return { ok: true }
      }
      throw err
    }

    return { ok: true }
  }
}
