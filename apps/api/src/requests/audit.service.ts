import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

export interface AuditEntry {
  entity: string
  entityId: string
  field: string
  oldValue: string | null
  newValue: string | null
  actorId?: string | null
}

/**
 * Writes one AuditLog row. Not optional (spec §5.7): both sides can edit a
 * request before packing, and this is the record that replaces the one
 * person's memory this whole workflow exists to stand in for.
 *
 * `record` takes the caller's own transaction client rather than owning a
 * PrismaService of its own -- callers MUST invoke it from inside the same
 * `$transaction` as the mutation it describes. A row inserted after the
 * fact, or on a failed transaction that rolls back separately, is exactly
 * the "edit with no record of who made it" this exists to prevent.
 */
@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        entity: entry.entity,
        entityId: entry.entityId,
        field: entry.field,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        actorId: entry.actorId ?? null,
      },
    })
  }
}
