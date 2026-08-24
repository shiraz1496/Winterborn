import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { hash as hashArgon2 } from '@node-rs/argon2'
import {
  createAdminUserInputSchema,
  updateAdminUserInputSchema,
  type AdminUserDto,
  type AdminUserWithPasswordDto,
  type CreateAdminUserInput,
  type UpdateAdminUserInput,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/// Owner-only user administration. Everything password-related routes
/// through @node-rs/argon2 with library defaults, matching cli:seed-users
/// -- so a user created here is indistinguishable from one seeded.
///
/// Passwords: an owner may pre-provision an account without one; the user
/// then cannot log in until a password is set. On create/reset, the
/// plaintext is returned to the caller ONCE so the owner can pass it on;
/// nothing else exposes it and it is never persisted in plaintext.
///
/// MARKET_MANAGER users must have a `locationId` to be useful, but the
/// service does not force one at write time -- an owner may create the
/// account first, then attach a location. Existing MARKET_MANAGER checks
/// downstream (RequestsService) treat a null locationId as "sees nothing",
/// which is the fail-safe default.
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AdminUserDto[]> {
    const rows = await this.prisma.user.findMany({ orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { name: 'asc' }] })
    return rows.map(toDto)
  }

  async create(raw: CreateAdminUserInput): Promise<AdminUserWithPasswordDto> {
    const input = createAdminUserInputSchema.parse(raw)
    await this.assertLocationValidForRole(input.role, input.locationId ?? null)
    const passwordHash = input.password ? await hashArgon2(input.password) : null

    try {
      const created = await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          locationId: input.locationId ?? null,
          passwordHash,
        },
      })
      return { ...toDto(created), password: input.password ?? null }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`email already in use`)
      }
      throw err
    }
  }

  async update(id: string, raw: UpdateAdminUserInput, actorId: string): Promise<AdminUserWithPasswordDto> {
    const input = updateAdminUserInputSchema.parse(raw)
    const existing = await this.prisma.user.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`user ${id} not found`)

    const nextRole = input.role ?? existing.role
    // `locationId: undefined` means "don't touch"; `null` means "clear it".
    const nextLocationId = input.locationId === undefined ? existing.locationId : input.locationId
    await this.assertLocationValidForRole(nextRole, nextLocationId)

    if (input.isActive === false && existing.id === actorId) {
      throw new BadRequestException('you cannot deactivate your own account')
    }
    if (input.role && input.role !== 'OWNER' && existing.role === 'OWNER') {
      const owners = await this.prisma.user.count({ where: { role: 'OWNER', isActive: true, id: { not: id } } })
      if (owners === 0) {
        throw new BadRequestException('at least one active owner must remain')
      }
    }
    if (input.isActive === false && existing.role === 'OWNER') {
      const owners = await this.prisma.user.count({ where: { role: 'OWNER', isActive: true, id: { not: id } } })
      if (owners === 0) {
        throw new BadRequestException('at least one active owner must remain')
      }
    }

    const passwordHash = input.password ? await hashArgon2(input.password) : undefined

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: input.name,
        role: input.role,
        isActive: input.isActive,
        locationId: input.locationId === undefined ? undefined : input.locationId,
        passwordHash,
      },
    })
    return { ...toDto(updated), password: input.password ?? null }
  }

  private async assertLocationValidForRole(role: string, locationId: string | null): Promise<void> {
    if (!locationId) return
    const loc = await this.prisma.location.findUnique({ where: { id: locationId } })
    if (!loc) throw new BadRequestException(`location ${locationId} does not exist`)
    if (role === 'MARKET_MANAGER' && loc.kind !== 'MARKET') {
      throw new BadRequestException('a MARKET_MANAGER must be scoped to a MARKET location')
    }
  }
}

function toDto(row: {
  id: string
  email: string
  name: string
  role: string
  locationId: string | null
  isActive: boolean
  passwordHash: string | null
}): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as AdminUserDto['role'],
    locationId: row.locationId,
    isActive: row.isActive,
    hasPassword: row.passwordHash !== null,
  }
}
