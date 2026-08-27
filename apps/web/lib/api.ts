import { z } from 'zod'
import {
  adminLocationSchema,
  adminUserSchema,
  adminUserWithPasswordSchema,
  syncSquareLocationsResultSchema,
  assignColourFamilyInputSchema,
  boxLabelSchema,
  boxLineSchema,
  boxSchema,
  categorySchema,
  colourFamilySchema,
  colourVariantSchema,
  createWarehouseVariantInputSchema,
  createLoadInputSchema,
  createRequestInputSchema,
  createRequestLineInputSchema,
  currentUserSchema,
  decisionQueueRowSchema,
  dispatchResultSchema,
  evaluateAllResultSchema,
  healthResponseSchema,
  intakeInputSchema,
  intakeResultSchema,
  loadDispatchResultSchema,
  loadSchema,
  loadWithBoxesSchema,
  locationSchema,
  loginResponseSchema,
  lowStockRowSchema,
  meResponseSchema,
  notificationsListSchema,
  packBoxInputSchema,
  requestLineAnalysisSchema,
  requestLineSchema,
  restockRequestBaseSchema,
  restockRequestSchema,
  salesRowSchema,
  setSquareIdInputSchema,
  sizeOptionSchema,
  squareMappingRowSchema,
  stockLevelSchema,
  thresholdSchema,
  transitionRequestInputSchema,
  unassignedColourVariantSchema,
  updateRequestLineInputSchema,
  variationSummarySchema,
  warehouseVariantSummarySchema,
  type AssignColourFamilyInput,
  type CreateAdminUserInput,
  type CreateLoadInput,
  type CreateRequestInput,
  type CreateRequestLineInput,
  type CreateWarehouseVariantInput,
  type IntakeInput,
  type PackBoxInput,
  type UpdateAdminUserInput,
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

export async function login(email: string, password: string) {
  return (await request('POST', '/auth/login', loginResponseSchema, { email, password })).user
}

export async function logout() {
  await request('POST', '/auth/logout', z.object({ ok: z.literal(true) }))
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

export function createWarehouseVariant(input: CreateWarehouseVariantInput) {
  createWarehouseVariantInputSchema.parse(input)
  return request('POST', '/catalog/warehouse-variants', warehouseVariantSummarySchema, input)
}

export function listCategories() {
  return request('GET', '/catalog/categories', z.array(categorySchema))
}

export function listSizeOptions(categoryId?: string) {
  return request('GET', `/catalog/size-options${qs({ categoryId })}`, z.array(sizeOptionSchema))
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

// ---- square mapping (owner + warehouse manager only) ---------------------

export function listSquareMapping() {
  return request('GET', '/catalog/square-mapping', z.array(squareMappingRowSchema))
}

export function setItemGroupSquareId(itemGroupId: string, squareId: string | null) {
  const body = setSquareIdInputSchema.parse({ squareId })
  return request(
    'PATCH',
    `/catalog/item-groups/${itemGroupId}/square-id`,
    z.object({ id: z.string(), name: z.string(), squareItemId: z.string().nullable() }),
    body,
  )
}

export function setVariationSquareId(variationId: string, squareId: string | null) {
  const body = setSquareIdInputSchema.parse({ squareId })
  return request(
    'PATCH',
    `/catalog/variations/${variationId}/square-id`,
    z.object({ id: z.string(), squareVariationId: z.string().nullable() }),
    body,
  )
}

export function setWarehouseVariantSquareId(warehouseVariantId: string, squareId: string | null) {
  const body = setSquareIdInputSchema.parse({ squareId })
  return request(
    'PATCH',
    `/catalog/warehouse-variants/${warehouseVariantId}/square-id`,
    z.object({ id: z.string(), squareVariationId: z.string().nullable() }),
    body,
  )
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

export function getRequestAnalysis(requestId: string) {
  return request('GET', `/requests/${requestId}/analysis`, z.array(requestLineAnalysisSchema))
}

export function reportRequestMissing(requestId: string) {
  return request('POST', `/requests/${requestId}/report-missing`, z.object({ ok: z.literal(true) }))
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

export function dispatchLoad(id: string) {
  return request('POST', `/loads/${id}/dispatch`, loadDispatchResultSchema)
}

// ---- intake -------------------------------------------------------------------

export function receiveIntake(input: IntakeInput) {
  intakeInputSchema.parse(input)
  return request('POST', '/intake', intakeResultSchema, input)
}

// ---- notifications -----------------------------------------------------------

export function listNotifications() {
  return request('GET', '/notifications', notificationsListSchema)
}

// ---- admin (owner-only) ------------------------------------------------------

export function listAdminUsers() {
  return request('GET', '/admin/users', z.array(adminUserSchema))
}

export function createAdminUser(input: CreateAdminUserInput) {
  return request('POST', '/admin/users', adminUserWithPasswordSchema, input)
}

export function updateAdminUser(id: string, input: UpdateAdminUserInput) {
  return request('PATCH', `/admin/users/${id}`, adminUserWithPasswordSchema, input)
}

// ---- admin locations (owner + warehouse manager) ----------------------------

export function listAdminLocations() {
  return request('GET', '/admin/locations', z.array(adminLocationSchema))
}

export function syncSquareLocations() {
  return request('POST', '/admin/locations/sync', syncSquareLocationsResultSchema)
}
