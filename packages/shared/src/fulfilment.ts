import { z } from 'zod'

export const boxStateSchema = z.enum(['PACKING', 'DISPATCHED', 'ARRIVED', 'RETURNED'])
export type BoxState = z.infer<typeof boxStateSchema>

export const packBoxLineInputSchema = z.object({
  warehouseVariantId: z.string().min(1),
  quantity: z.number().int().positive(),
  /// Which RestockRequest this line fulfils. Optional at the line level:
  /// when omitted the server falls back to the top-level `requestId` so
  /// existing single-request calls keep working unchanged. Multi-request
  /// boxes populate per-line and omit the top-level id.
  requestId: z.string().min(1).optional(),
})
export type PackBoxLineInput = z.infer<typeof packBoxLineInputSchema>

export const packBoxInputSchema = z.object({
  destinationLocationId: z.string().min(1),
  requestId: z.string().min(1).optional(),
  lines: z.array(packBoxLineInputSchema).min(1),
})
export type PackBoxInput = z.infer<typeof packBoxInputSchema>

export const boxLineSchema = z.object({
  id: z.string(),
  boxId: z.string(),
  warehouseVariantId: z.string(),
  /// Populated when the server knows which request this line belongs to
  /// (multi-request box). Null on legacy rows whose ownership was still
  /// only recorded at the Box level.
  requestId: z.string().nullable(),
  quantity: z.number().int(),
})
export type BoxLineDto = z.infer<typeof boxLineSchema>

export const boxSchema = z.object({
  id: z.string(),
  requestId: z.string().nullable(),
  destinationLocationId: z.string(),
  state: boxStateSchema,
  qrToken: z.string(),
  packedById: z.string().nullable(),
  packedAt: z.coerce.date().nullable(),
  dispatchedAt: z.coerce.date().nullable(),
  arrivedAt: z.coerce.date().nullable(),
  lines: z.array(boxLineSchema),
})
export type BoxDto = z.infer<typeof boxSchema>

/// One printed line on the box label — enough for the market manager
/// unpacking the box to check the contents against the sticker without
/// scanning first. Names are denormalised from the WarehouseVariant on
/// the server so the label never needs a second lookup.
export const boxLabelLineSchema = z.object({
  warehouseVariantId: z.string(),
  itemGroupName: z.string(),
  colourVariantName: z.string(),
  sizeOptionName: z.string(),
  warehouseSku: z.string(),
  quantity: z.number().int(),
})
export type BoxLabelLine = z.infer<typeof boxLabelLineSchema>

export const boxLabelSchema = z.object({
  qrToken: z.string(),
  destinationLocationId: z.string(),
  destinationLocationName: z.string(),
  lineCount: z.number().int(),
  packedAt: z.coerce.date().nullable(),
  lines: z.array(boxLabelLineSchema),
})
export type BoxLabelDto = z.infer<typeof boxLabelSchema>

/// POST /boxes/receive — market-manager scans a box QR. Body carries the
/// qrToken; the server looks up the box, verifies the scanner's location
/// matches the destination, posts INTAKE ledger events for every line,
/// and marks the box ARRIVED. If this was the last un-received box for
/// the parent request, the request auto-transitions to CLOSED in the
/// same call.
export const receiveBoxInputSchema = z.object({
  qrToken: z.string().min(1),
  /// Optional scope from the client. When the market manager opens the
  /// scanner from a specific request's detail page, we send that
  /// request's id here so the server can reject a scan of a box that
  /// belongs to a different request BEFORE any ledger event is
  /// appended. Without this, the "wrong box" message the client shows
  /// is cosmetic — the intake has already landed.
  expectedRequestId: z.string().min(1).optional(),
})
export type ReceiveBoxInput = z.infer<typeof receiveBoxInputSchema>

/// Response mirrors what the receiver UI needs to show a success card
/// without a follow-up fetch: box identity + destination for readback,
/// arrivedAt as proof, and the parent request's fresh state + progress
/// counter ("2 of 3 boxes received").
export const receiveBoxResultSchema = z.object({
  box: z.object({
    id: z.string(),
    qrToken: z.string(),
    destinationLocationName: z.string(),
    lineCount: z.number().int(),
    arrivedAt: z.coerce.date(),
    alreadyReceived: z.boolean(),
    /// What actually landed at the market on this scan. The client
    /// uses this to show the operator exactly what came in (versus
    /// what the request asked for) — the difference between "we
    /// received 2 of 3 requested lines" is visible from this list
    /// alone.
    ///
    /// Defaulted to `[]` so a browser talking to an older-shape API
    /// (added `contents` in a later deploy) still parses cleanly —
    /// only the toast's per-item breakdown degrades to a plain count.
    contents: z.array(boxLabelLineSchema).default([]),
  }),
  request: z.object({
    id: z.string(),
    state: z.string(),
    boxesReceived: z.number().int(),
    boxesTotal: z.number().int(),
    closed: z.boolean(),
  }).nullable(),
  /// Every request this scan touched. For a single-request box that's
  /// just `[request]` (or empty for loose boxes). For a shared box that
  /// fulfils N requests, this lists progress for all N so the UI can
  /// tell the operator "Box received — request A closed, request B is
  /// now 2 of 3 in". Populated from every distinct requestId on the
  /// box's lines plus Box.requestId when set.
  ///
  /// Defaulted to `[]` so an older-shape API still parses cleanly.
  requests: z.array(z.object({
    id: z.string(),
    state: z.string(),
    boxesReceived: z.number().int(),
    boxesTotal: z.number().int(),
    closed: z.boolean(),
  })).default([]),
})
export type ReceiveBoxResult = z.infer<typeof receiveBoxResultSchema>

export const dispatchResultSchema = z.object({
  boxId: z.string(),
  transfers: z.array(
    z.object({
      warehouseVariantId: z.string(),
      transferId: z.string(),
      created: z.boolean(),
    }),
  ),
})
export type DispatchResult = z.infer<typeof dispatchResultSchema>

export const createLoadInputSchema = z.object({
  vehicleLabel: z.string().min(1),
  destinationLocationId: z.string().min(1),
})
export type CreateLoadInput = z.infer<typeof createLoadInputSchema>

export const loadSchema = z.object({
  id: z.string(),
  vehicleLabel: z.string(),
  destinationLocationId: z.string(),
  createdById: z.string().nullable(),
  createdAt: z.coerce.date(),
  dispatchedAt: z.coerce.date().nullable(),
})
export type LoadDto = z.infer<typeof loadSchema>

export const loadBoxSchema = z.object({
  loadId: z.string(),
  boxId: z.string(),
  scannedAt: z.coerce.date(),
})
export type LoadBoxDto = z.infer<typeof loadBoxSchema>

export const loadWithBoxesSchema = loadSchema.extend({
  boxes: z.array(loadBoxSchema),
})
export type LoadWithBoxesDto = z.infer<typeof loadWithBoxesSchema>

export const loadDispatchResultSchema = z.object({
  loadId: z.string(),
  boxes: z.array(dispatchResultSchema),
})
export type LoadDispatchResult = z.infer<typeof loadDispatchResultSchema>
