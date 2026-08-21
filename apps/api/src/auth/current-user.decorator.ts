import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { CurrentUserPayload } from './current-user.js'

/// Pulls the user `JwtGuard` attached to the request. Only valid behind
/// `@UseGuards(JwtGuard)` -- otherwise `request.user` is undefined.
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): CurrentUserPayload => {
  const req = ctx.switchToHttp().getRequest<{ user: CurrentUserPayload }>()
  return req.user
})
