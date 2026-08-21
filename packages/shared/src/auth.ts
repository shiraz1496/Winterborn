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

export const loginResponseSchema = z.object({ user: currentUserSchema })
export type LoginResponse = z.infer<typeof loginResponseSchema>

export const loginInputSchema = z.object({
  email: z.string(),
  password: z.string(),
})
export type LoginInput = z.infer<typeof loginInputSchema>
