import { z } from 'zod'
import {
  assignColourFamilyInputSchema,
  boxLabelSchema,
  boxLineSchema,
  boxSchema,
  colourFamilySchema,
  colourVariantSchema,
  createLoadInputSchema,
  createRequestInputSchema,
  createRequestLineInputSchema,
  currentUserSchema,
  decisionQueueRowSchema,
  dispatchResultSchema,
  evaluateAllResultSchema,
  healthResponseSchema,
  loadDispatchResultSchema,
  loadSchema,
  loadWithBoxesSchema,
  locationSchema,
  lowStockRowSchema,
  meResponseSchema,
  packBoxInputSchema,
  requestLineSchema,
  requestMagicLinkResultSchema,
  restockRequestBaseSchema,
  restockRequestSchema,
  salesRowSchema,
  stockLevelSchema,
  thresholdSchema,
  transitionRequestInputSchema,
  unassignedColourVariantSchema,
  updateRequestLineInputSchema,
  variationSummarySchema,
  verifyResponseSchema,
  warehouseVariantSummarySchema,
  type AssignColourFamilyInput,
  type CreateLoadInput,
  type CreateRequestInput,
  type CreateRequestLineInput,
  type PackBoxInput,
  type UpdateRequestLineInput,
} from '@winterborn/shared'

/// Every path below is relative to this. Override with
/// NEXT_PUBLIC_API_URL for anything other than local dev.
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

/**
 * Thrown for any non-2xx response. Carries the HTTP status so callers can
 * tell "you're not allowed to do that" (403) apart from "that request made
 * no sense" (400) apart from "the server choked" (5xx) without re-parsing
 * the message string.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The one function in this file that talks to the network. Every exported
 * helper below calls this and then validates the JSON body through a Zod
 * schema from `@winterborn/shared` before handing it back -- so a backend
 * change that silently breaks the contract throws here, in dev, loudly,
 * instead of quietly rendering a wrong stock number to someone deciding
 * what to ship. `credentials: 'include'` is required on every call: the
 * session lives in an httpOnly cookie scoped to the API's own origin.
 */
async function request<S extends z.ZodTypeAny>(
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    let message = res.statusText
    try {
      const payload = (await res.json()) as { message?: string | string[] }
      if (Array.isArray(payload.message)) message = payload.message.join('; ')
      else if (typeof payload.message === 'string') message = payload.message
    } catch {
      // Body wasn't JSON (or was empty) -- statusText is the best we have.
    }
    throw new ApiError(res.status, message)
  }

  if (res.status === 204) return schema.parse(undefined)
  const json = await res.json()
  return schema.parse(json)
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)
  if (entries.length === 0) return ''
  return `?${new URLSearchParams(entries).toString()}`
}

// ---- auth ----------------------------------------------------------------

export function requestMagicLink(email: string) {
  return request('POST', '/auth/magic-link', requestMagicLinkResultSchema, { email })
}

export async function verifyMagicLink(token: string) {
  return (await request('POST', '/auth/verify', verifyResponseSchema, { token })).user
}

export async function getMe() {
  return (await request('GET', '/auth/me', meResponseSchema)).user
}

export const CurrentUser = currentUserSchema

// ---- catalog / locations / stock ------------------------------------------

export function listLocations() {
  return request('GET', '/locations', z.array(locationSchema))
}

export function listVariations() {
  return request('GET', '/catalog/variations', z.array(variationSummarySchema))
}

export function listWarehouseVariants(variationId?: string) {
  return request(
    'GET',
    `/catalog/warehouse-variants${qs({ variationId })}`,
    z.array(warehouseVariantSummarySchema),
  )
}

export function listThresholds(locationId?: string) {
  return request('GET', `/catalog/thresholds${qs({ locationId })}`, z.array(thresholdSchema))
}

export function lowStock(locationId?: string) {
  return request('GET', `/stock/low${qs({ locationId })}`, z.array(lowStockRowSchema))
}

export function stockByFamily(locationId?: string) {
  return request('GET', `/stock/by-family${qs({ locationId })}`, z.array(stockLevelSchema))
}

export function stockByVariant(locationId?: string) {
  return request('GET', `/stock/by-variant${qs({ locationId })}`, z.array(stockLevelSchema))
}

export function salesSince(locationId?: string, days?: number) {
  return request('GET', `/stock/sales-since${qs({ locationId, days: days?.toString() })}`, z.array(salesRowSchema))
}

// ---- thresholds / decision queue -------------------------------------------

export function decisionQueue() {
  return request('GET', '/thresholds/decision-queue', z.array(decisionQueueRowSchema))
}

export function evaluateAllThresholds() {
  return request('POST', '/thresholds/evaluate-all', evaluateAllResultSchema)
}

// ---- health -------------------------------------------------------------------

export function getHealth() {
  return request('GET', '/health', healthResponseSchema)
}

export function listUnassignedColourVariants() {
  return request('GET', '/catalog/colour-variants/unassigned', z.array(unassignedColourVariantSchema))
}

export function listColourFamilies(categoryId: string) {
  return request('GET', `/catalog/colour-families${qs({ categoryId })}`, z.array(colourFamilySchema))
}

export function assignColourFamily(id: string, input: AssignColourFamilyInput) {
  assignColourFamilyInputSchema.parse(input)
  return request('PATCH', `/catalog/colour-variants/${id}`, colourVariantSchema, input)
}

// ---- requests ---------------------------------------------------------------

export function listRequests() {
  return request('GET', '/requests', z.array(restockRequestSchema))
}

export function getRequest(id: string) {
  return request('GET', `/requests/${id}`, restockRequestSchema)
}

export function createRequest(input: CreateRequestInput) {
  createRequestInputSchema.parse(input)
  return request('POST', '/requests', restockRequestSchema, input)
}

export function addRequestLine(requestId: string, input: CreateRequestLineInput) {
  createRequestLineInputSchema.parse(input)
  return request('POST', `/requests/${requestId}/lines`, requestLineSchema, input)
}

export function updateRequestLine(requestId: string, lineId: string, input: UpdateRequestLineInput) {
  updateRequestLineInputSchema.parse(input)
  return request('PATCH', `/requests/${requestId}/lines/${lineId}`, requestLineSchema, input)
}

export function transitionRequest(requestId: string, state: string) {
  const input = transitionRequestInputSchema.parse({ state })
  return request('POST', `/requests/${requestId}/transition`, restockRequestBaseSchema, input)
}

// ---- boxes ------------------------------------------------------------------

export function packBox(input: PackBoxInput) {
  packBoxInputSchema.parse(input)
  return request('POST', '/boxes', boxSchema, input)
}

export function listBoxes(filter: { requestId?: string; destinationLocationId?: string } = {}) {
  return request('GET', `/boxes${qs(filter)}`, z.array(boxSchema))
}

export function getBox(id: string) {
  return request('GET', `/boxes/${id}`, boxSchema)
}

export function getBoxByToken(token: string) {
  return request('GET', `/boxes/by-token/${encodeURIComponent(token)}`, boxSchema)
}

export function addBoxLine(boxId: string, input: { warehouseVariantId: string; quantity: number }) {
  return request('POST', `/boxes/${boxId}/lines`, boxLineSchema, input)
}

export function dispatchBox(id: string) {
  return request('POST', `/boxes/${id}/dispatch`, dispatchResultSchema)
}

export function getBoxLabel(id: string) {
  return request('GET', `/boxes/${id}/label`, boxLabelSchema)
}

// ---- loads --------------------------------------------------------------------

export function createLoad(input: CreateLoadInput) {
  createLoadInputSchema.parse(input)
  return request('POST', '/loads', loadSchema, input)
}

export function listLoads() {
  return request('GET', '/loads', z.array(loadSchema))
}

export function getLoad(id: string) {
  return request('GET', `/loads/${id}`, loadWithBoxesSchema)
}

export function scanBoxOntoLoad(loadId: string, boxId: string) {
  return request('POST', `/loads/${loadId}/scan`, z.object({ loadId: z.string(), boxId: z.string(), scannedAt: z.coerce.date() }), {
    boxId,
  })
}

export function dispatchLoad(id: string) {
  return request('POST', `/loads/${id}/dispatch`, loadDispatchResultSchema)
}
