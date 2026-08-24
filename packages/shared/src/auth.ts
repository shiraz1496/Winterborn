import { z } from 'zod'

export const userRoleSchema = z.enum([
  'OWNER',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_OPERATOR',
  'MARKET_MANAGER',
  'SALES',
])
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

/// One row of the /admin/users list. Owner-only surface. Password material
/// is never returned -- only the plaintext of a just-set password is
/// echoed back on create/reset, once, so the owner can pass it to the new
/// user; nothing else exposes it.
export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  locationId: z.string().nullable(),
  isActive: z.boolean(),
  hasPassword: z.boolean(),
})
export type AdminUserDto = z.infer<typeof adminUserSchema>

/// Create-user input. `password` is optional so an owner can pre-provision
/// the account and set the password afterwards, but the account cannot log
/// in until one is set (see AuthService.login's `passwordHash` check). A
/// MARKET_MANAGER without a `locationId` is legal at the shape level but
/// scopes them to nothing until one is assigned.
export const createAdminUserInputSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: userRoleSchema,
  password: z.string().min(8).max(200).optional(),
  locationId: z.string().min(1).nullable().optional(),
})
export type CreateAdminUserInput = z.infer<typeof createAdminUserInputSchema>

export const updateAdminUserInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    role: userRoleSchema.optional(),
    isActive: z.boolean().optional(),
    locationId: z.string().min(1).nullable().optional(),
    password: z.string().min(8).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  })
export type UpdateAdminUserInput = z.infer<typeof updateAdminUserInputSchema>

/// Return shape for create + password-reset: the row plus, exactly once,
/// the plaintext password that was just set. The password never appears in
/// a GET response and is never persisted in plaintext; only its Argon2id
/// hash is stored.
export const adminUserWithPasswordSchema = adminUserSchema.extend({
  password: z.string().nullable(),
})
export type AdminUserWithPasswordDto = z.infer<typeof adminUserWithPasswordSchema>
