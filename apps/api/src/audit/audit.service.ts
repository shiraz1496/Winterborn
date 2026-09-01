import { Injectable } from '@nestjs/common'
import { Prisma, type AuditSource } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'

/// Central audit trail writer. Every state-changing operation calls one of
/// these methods so the AuditLog table stays a comprehensive 6W record
/// (What / Who / When / Where / Why / How). Inventory movements are NOT
/// audited here — LedgerEvent is the canonical inventory audit and is
/// append-only enforced by a DB trigger.
///
/// The signature is object-based so callers can add optional 6W dimensions
/// (source / locationId / reason / actorRole) as they become available at
/// each call site without changing the mandatory shape.
///
/// Callers usually pass a Prisma.TransactionClient so the audit row shares
/// the transaction with the domain write. If no tx is supplied, we fall
/// back to the top-level PrismaService — useful for post-hoc audits after
/// a caller has already committed (e.g. LedgerService.append is outside
/// its own tx for exactly this reason).
export interface AuditEntry {
  entity: string
  entityId: string
  field: string
  oldValue: string | null
  newValue: string | null
  actorId?: string | null
  actorRole?: string | null
  locationId?: string | null
  reason?: string | null
  source?: AuditSource
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: Prisma.TransactionClient | null, entry: AuditEntry): Promise<void> {
    const client = tx ?? this.prisma
    await client.auditLog.create({
      data: {
        entity: entry.entity,
        entityId: entry.entityId,
        field: entry.field,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        locationId: entry.locationId ?? null,
        reason: entry.reason ?? null,
        source: entry.source ?? 'UI',
      },
    })
  }

  /// Batch helper — one call for a multi-field change (e.g. a PATCH that
  /// renames AND moves an item group in the same transaction).
  async recordMany(tx: Prisma.TransactionClient | null, entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return
    const client = tx ?? this.prisma
    await client.auditLog.createMany({
      data: entries.map((entry) => ({
        entity: entry.entity,
        entityId: entry.entityId,
        field: entry.field,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        locationId: entry.locationId ?? null,
        reason: entry.reason ?? null,
        source: entry.source ?? 'UI',
      })),
    })
  }

  /// Convenience for "this thing just came into existence" — no old value.
  /// `newValue` should be a short summary string so the viewer can render
  /// it inline without another lookup ("Merino Beanie in Scarves > Peru").
  async recordCreation(
    tx: Prisma.TransactionClient | null,
    entity: string,
    entityId: string,
    summary: string,
    rest: Omit<AuditEntry, 'entity' | 'entityId' | 'field' | 'oldValue' | 'newValue'> = {},
  ): Promise<void> {
    await this.record(tx, {
      entity,
      entityId,
      field: 'created',
      oldValue: null,
      newValue: summary,
      ...rest,
    })
  }

  /// Convenience for state-machine transitions.
  async recordTransition(
    tx: Prisma.TransactionClient | null,
    entity: string,
    entityId: string,
    field: string,
    fromState: string,
    toState: string,
    rest: Omit<AuditEntry, 'entity' | 'entityId' | 'field' | 'oldValue' | 'newValue'> = {},
  ): Promise<void> {
    await this.record(tx, { entity, entityId, field, oldValue: fromState, newValue: toState, ...rest })
  }
}
