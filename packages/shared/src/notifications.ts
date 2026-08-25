import { z } from 'zod'

/// Doc 3 §3.2: on-screen surfacing of stock and workflow events. This is
/// the detection layer -- off-screen delivery (email/SMS) is deliberately
/// out of scope for now.
///
/// Not persisted. Derived on read by unioning across the RestockRequest,
/// AuditLog, and LedgerEvent tables. Sorted newest-first, capped at the
/// server so a busy season never blows up the client.
export const notificationKindSchema = z.enum([
  'REQUEST_DRAFTED',
  'REQUEST_ADVANCED',
  'INTAKE_RECORDED',
  'DISPATCH_RECORDED',
])
export type NotificationKind = z.infer<typeof notificationKindSchema>

export const notificationSchema = z.object({
  id: z.string(),
  kind: notificationKindSchema,
  at: z.coerce.date(),
  title: z.string(),
  body: z.string(),
  /// Best-effort deep-link into the page that owns this event, so the row
  /// can be a link rather than a dead label.
  href: z.string().nullable(),
  /// Location this event pertains to, if any. Used server-side to scope
  /// MARKET_MANAGER visibility to their own market.
  locationId: z.string().nullable(),
  locationName: z.string().nullable(),
})
export type Notification = z.infer<typeof notificationSchema>

export const notificationsListSchema = z.object({
  items: z.array(notificationSchema),
  /// True if the feed was capped -- lets the UI say "showing the last N"
  /// without asking a second time.
  truncated: z.boolean(),
})
export type NotificationsList = z.infer<typeof notificationsListSchema>

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  REQUEST_DRAFTED: 'Auto-drafted',
  REQUEST_ADVANCED: 'Request advanced',
  INTAKE_RECORDED: 'Intake',
  DISPATCH_RECORDED: 'Dispatch',
}
