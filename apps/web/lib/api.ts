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
  receiveBoxInputSchema,
  receiveBoxResultSchema,
  catalogBrowseResponseSchema,
  catalogItemDetailSchema,
  catalogItemGroupPageSchema,
  catalogItemRowSchema,
  catalogSearchResponseSchema,
  categorySchema,
  categoryTreeNodeSchema,
  colourFamilySchema,
  colourVariantSchema,
  createCategoryInputSchema,
  createProductInputSchema,
  createProductResultSchema,
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
  stockCorrectionInputSchema,
  stockCorrectionResultSchema,
  createProductAttributeInputSchema,
  createProductAttributeValueInputSchema,
  itemGroupDetailSchema,
  itemGroupMappingProgressSchema,
  squareCatalogItemSchema,
  squareCatalogSyncResultSchema,
  squareCatalogVariationSchema,
  squareMappingOrphansSchema,
  squareMappingRowSchema,
  updateItemGroupMappingSchema,
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
  type CreateCategoryInput,
  type CreateProductInput,
  type IntakeInput,
  type PackBoxInput,
  type StockCorrectionInput,
  type UpdateAdminUserInput,
  type UpdateRequestLineInput,
} from '@winterborn/shared'

/// Every path below is relative to this. NEXT_PUBLIC_API_URL, when set,
/// wins outright (needed for real deployments, where the API lives on its
/// own domain). Otherwise this is derived from whatever host is actually
/// viewing the page, not hardcoded to "localhost" -- the session cookie is
/// SameSite=Lax, which a cross-site fetch cannot set even with CORS
/// configured correctly. Pin the API to one fixed host (e.g. a LAN IP,
/// for phone/tablet testing) and it silently breaks login for anyone
/// viewing the app from a different host (e.g. plain "localhost"), since
/// the browser drops the Set-Cookie response instead of erroring loudly.
/// Matching hosts (only the port differs) keeps every viewer same-site.
function resolveApiOrigin(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL
  if (typeof window !== 'undefined') return `http://${window.location.hostname}:3001`
  return 'http://localhost:3001'
}

export const API_ORIGIN = resolveApiOrigin()

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
    /// Structured details from the Nest exception body (e.g. the
    /// InsufficientStockException details array). Callers that recognise
    /// their own error codes can down-cast; unknown types are ignored.
    public readonly details?: unknown,
    public readonly code?: string,
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
    let details: unknown
    let code: string | undefined
    try {
      const payload = (await res.json()) as { message?: string | string[]; details?: unknown; code?: string }
      if (Array.isArray(payload.message)) message = payload.message.join('; ')
      else if (typeof payload.message === 'string') message = payload.message
      details = payload.details
      code = typeof payload.code === 'string' ? payload.code : undefined
    } catch {
      // Body wasn't JSON (or was empty) -- statusText is the best we have.
    }
    throw new ApiError(res.status, message, details, code)
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

// ---- catalog browse (Sortly-style folder hierarchy) ----------------------

/// Tree-aware folder browse. `folderId` picks a folder to drill into
/// (omit for root); `locationId` scopes on-hand aggregates to a specific
/// warehouse or market. Owner/WM omitting `locationId` defaults server-
/// side to the first warehouse; MM is always pinned to their own market
/// regardless of what they pass.
export function browseFolder(folderId?: string, locationId?: string) {
  return request(
    'GET',
    `/catalog/browse${qs({ folderId, locationId })}`,
    catalogBrowseResponseSchema,
  )
}

/// Deep tree-wide search over folder and product names. Empty `q` returns
/// zero hits — callers should short-circuit and skip this call in that case.
export function searchCatalog(q: string, locationId?: string) {
  return request(
    'GET',
    `/catalog/search${qs({ q, locationId })}`,
    catalogSearchResponseSchema,
  )
}

export function browseCatalogItems(itemGroupId: string, locationId?: string) {
  return request(
    'GET',
    `/catalog/browse/item-groups/${encodeURIComponent(itemGroupId)}/items${qs({ locationId })}`,
    catalogItemGroupPageSchema,
  )
}

export function getCatalogItemDetail(warehouseVariantId: string) {
  return request(
    'GET',
    `/catalog/browse/items/${encodeURIComponent(warehouseVariantId)}`,
    catalogItemDetailSchema,
  )
}

export function correctStock(input: StockCorrectionInput) {
  const body = stockCorrectionInputSchema.parse(input)
  return request('POST', '/stock/correction', stockCorrectionResultSchema, body)
}

// ---- product creation (intake "+ Create new product" modal) --------------

export function createCategory(input: CreateCategoryInput) {
  const body = createCategoryInputSchema.parse(input)
  return request('POST', '/catalog/categories', categoryTreeNodeSchema, body)
}

export function createProduct(input: CreateProductInput) {
  const body = createProductInputSchema.parse(input)
  return request('POST', '/catalog/products', createProductResultSchema, body)
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

// ---- square catalog cache (owner + warehouse manager only) ---------------

export function syncSquareCatalog() {
  return request('POST', '/catalog/sync-square', squareCatalogSyncResultSchema, {})
}

export function listSquareCatalogItems() {
  return request('GET', '/catalog/square-items', z.array(squareCatalogItemSchema))
}

export function listSquareCatalogVariations(squareItemId: string) {
  return request(
    'GET',
    `/catalog/square-items/${encodeURIComponent(squareItemId)}/variations`,
    z.array(squareCatalogVariationSchema),
  )
}

export function listSquareMappingOrphans() {
  return request('GET', '/catalog/square-mapping-orphans', squareMappingOrphansSchema)
}

export function listItemGroupsForMapping() {
  return request('GET', '/catalog/item-groups', z.array(itemGroupMappingProgressSchema))
}

export function getItemGroupMappingDetail(itemGroupId: string) {
  return request(
    'GET',
    `/catalog/item-groups/${encodeURIComponent(itemGroupId)}/mapping-detail`,
    itemGroupDetailSchema,
  )
}

export function updateItemGroupMapping(
  itemGroupId: string,
  input: { squareItemId?: string | null; skus?: Array<{ warehouseVariantId: string; squareVariationId: string | null }> },
) {
  const body = updateItemGroupMappingSchema.parse(input)
  return request(
    'PATCH',
    `/catalog/item-groups/${encodeURIComponent(itemGroupId)}/mapping`,
    z.object({ itemGroupId: z.string(), ok: z.boolean() }),
    body,
  )
}

export function createProductAttribute(itemGroupId: string, input: { name: string; displayOrder?: number }) {
  const body = createProductAttributeInputSchema.parse(input)
  return request(
    'POST',
    `/catalog/item-groups/${encodeURIComponent(itemGroupId)}/attributes`,
    z.object({ id: z.string(), name: z.string(), displayOrder: z.number().int(), itemGroupId: z.string() }),
    body,
  )
}

export function createProductAttributeValue(productAttributeId: string, input: { value: string; displayOrder?: number }) {
  const body = createProductAttributeValueInputSchema.parse(input)
  return request(
    'POST',
    `/catalog/product-attributes/${encodeURIComponent(productAttributeId)}/values`,
    z.object({ id: z.string(), value: z.string(), displayOrder: z.number().int(), productAttributeId: z.string() }),
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

/// Delete a still-PACKING box. Used by the re-pack flow before writing
/// a fresh box for the same request. Dispatched boxes cannot be deleted
/// (server enforces).
export function discardBox(id: string) {
  return request('DELETE', `/boxes/${id}`, z.object({ id: z.string(), discarded: z.boolean() }))
}

export function getBoxLabel(id: string) {
  return request('GET', `/boxes/${id}/label`, boxLabelSchema)
}

export function receiveBox(qrToken: string, expectedRequestId?: string) {
  const body = receiveBoxInputSchema.parse({ qrToken, expectedRequestId })
  return request('POST', '/boxes/receive', receiveBoxResultSchema, body)
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
