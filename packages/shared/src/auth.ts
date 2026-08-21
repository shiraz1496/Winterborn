import { z } from 'zod'

export const userRoleSchema = z.enum(['OWNER', 'WAREHOUSE', 'MARKET_MANAGER', 'OPERATOR'])
export type UserRole = z.infer<typeof userRoleSchema>

export const currentUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  locationId: z.string().nullable(),
})
export type CurrentUserDto = z.infer<typeof currentUserSchema>

export const meResponseSchema = z.object({ user: currentUserSchema })
export type MeResponse = z.infer<typeof meResponseSchema>

export const verifyResponseSchema = z.object({ user: currentUserSchema })
export type VerifyResponse = z.infer<typeof verifyResponseSchema>

export const requestMagicLinkResultSchema = z.object({
  ok: z.literal(true),
  /// Only present when MAIL_TRANSPORT=console -- dev/sandbox only. See
  /// AuthService.requestMagicLink.
  devLink: z.string().optional(),
})
export type RequestMagicLinkResult = z.infer<typeof requestMagicLinkResultSchema>
