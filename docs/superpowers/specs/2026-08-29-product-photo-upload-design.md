# Product photo upload (Cloudinary), mobile/tablet only

**Date:** 2026-08-29
**Status:** Approved, ready for implementation planning
**Author context:** CEO asked for the ability to attach photos when creating a
product, matching how Sortly worked. Scoped down to mobile/tablet only — that
is where product creation actually happens (warehouse intake), not desktop.
PWA installability was requested alongside this but is deliberately split
into its own, separate spec — the two are independent and this one should not
wait on that one.

## Problem

`ProductCreationService` (`apps/api/src/catalog/product-creation.service.ts`)
creates new `WarehouseVariant` rows with `photoUrls: []` and no way to attach
an image. Every image in the catalog today came from the one-time Sortly CSV
import (`cli:import-sortly`) — a product created through the app's own
"+ Create new product" flow is permanently photo-less. This blocks staff from
building out the catalog with the same visual record Sortly gave them.

## Goals

- Let staff attach photos to a new product while creating it, at the same
  granularity Sortly used (per SKU — one colour × one size row).
- On mobile/tablet, offer a camera-capture option, not just file picking.
- Store images in Cloudinary; keep the existing `WarehouseVariant.photoUrls`
  / `ColourVariant.photoUrl` fields as the source of truth — no schema
  changes to storage.
- Keep image bytes off our own server; the API only ever mints short-lived,
  signed upload authorization.
- Cap upload size sanely and compress client-side so Cloudinary's free tier
  isn't burned needlessly.

## Non-goals

- Desktop image upload. The "+ Create new product" flow on desktop is
  unchanged — no photo affordance appears at all.
- Editing/replacing photos on an *existing* product after creation (this
  spec covers photo attachment only at creation time).
- PWA / installability — separate spec.
- Deleting/moving photos already archived from Sortly.
- Server-side image processing (resizing, thumbnails) beyond whatever
  Cloudinary itself provides — compression happens client-side before
  upload.

## Data model

No schema changes. Reuses:

- `WarehouseVariant.photoUrls String[]` — every photo for one SKU (colour +
  size), same field the Sortly importer already populates from
  `Photo1..Photo8`.
- `ColourVariant.photoUrl String?` — fallback representative image for a
  colour, used everywhere a SKU-level photo is absent
  (`catalog-read.service.ts`). Populated today at import time from the first
  row's first photo for that colour; the new create path replicates this:
  the first photo of the first SKU created for a given colour backfills
  `ColourVariant.photoUrl` if it is currently null. Never overwrites an
  existing value.

`packages/shared/src/catalog.ts` — `createProductInputSchema` gains one new
optional field:

```ts
photoUrls: z.record(z.string(), z.array(z.string().url())).default({})
```

Keyed identically to the existing `quantities` field
(`"${primaryValue ?? '__none__'}::${colour ?? '__none__'}"`). A cell absent
from `photoUrls` simply gets `photoUrls: []` on its `WarehouseVariant`,
matching today's default behavior.

## Architecture / data flow

```
Tablet/phone browser (viewport < 1024px)
  └─ NewProductModal: per matrix cell, "Add photo" → camera or gallery picker
       └─ browser-image-compression: reject >10MB, compress toward ~3MB target
       └─ held in memory as pending files; thumbnail + remove (x) shown;
          nothing uploaded yet
  └─ On "Submit":
       1. POST /catalog/products/upload-signature   (new endpoint, JWT + role-gated)
            -> { timestamp, signature, apiKey, cloudName, folder }
       2. Browser uploads every pending file directly to Cloudinary's
          upload API using that signature -> gets back secure_url per image.
          If ANY upload in the batch fails, abort -- no partial product is
          created, no call to step 3 is made.
       3. POST /catalog/products   (existing endpoint, extended payload)
            -> body now includes `photoUrls` keyed like `quantities`
       4. ProductCreationService assigns photoUrls per WarehouseVariant and
          backfills ColourVariant.photoUrl per the rule above, inside the
          same transaction as the rest of product creation.
```

Images upload only at final submit (explicit product decision: avoids the
orphan-cleanup complexity of upload-on-capture, at the cost of a slower
submit and an all-or-nothing batch). Our API never receives image bytes.

## New endpoint: `POST /catalog/products/upload-signature`

- Guards: `JwtGuard` + `RolesGuard`, `@Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')` — identical to `POST /catalog/products`.
- No request body.
- Response:
  ```json
  { "timestamp": 1735500000, "signature": "...", "apiKey": "...", "cloudName": "...", "folder": "winterborn/products" }
  ```
- Signature computed server-side as Cloudinary's documented
  `sha1(sorted param string + api_secret)` over exactly `{ timestamp, folder }`
  — no other params are signable from the client, so a signature cannot be
  reused to upload outside the configured folder or with different
  transformation params.
- Config: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`,
  `CLOUDINARY_UPLOAD_FOLDER` (already added to `.env` / `.env.example`).
  Secret never leaves the server.

## Client: compression pipeline

Library: `browser-image-compression` (new dependency, `apps/web`). Chosen
over hand-rolled Canvas API compression because it correctly handles EXIF
orientation (phone photos otherwise come out rotated) and is well-exercised
across mobile browsers.

Per selected/captured file, before it becomes a "pending" photo in the form:

1. If raw file size > 10MB: reject immediately with an inline error, do not
   attempt compression.
2. Otherwise compress toward a ~3MB target (resize longest edge toward
   ~2000px and reduce quality iteratively, per the library's own
   `maxSizeMB` / `maxWidthOrHeight` options).
3. Show the resulting thumbnail and final size to the user.

Compression runs synchronously per photo as it's added (not deferred to
submit time), so the user sees size/thumbnail immediately — only the
Cloudinary *upload* is deferred to submit.

## UI / device gating

- Gate: a resize-aware hook reporting `window.innerWidth < 1024`. Rotating a
  tablet does not lose the feature (hook re-evaluates on resize/orientation
  change events, not just at mount).
- Below the threshold, each matrix cell in `NewProductModal` gets an
  "Add photo" control opening
  `<input type="file" accept="image/*" capture="environment">` — hints the
  device's rear camera on supporting mobile browsers while still allowing
  the user to back out to gallery/files.
- At or above the threshold (desktop), the matrix cell is rendered exactly
  as it is today — no photo affordance, no compression library loaded.
- Multiple photos per cell, no hard UI cap beyond Sortly's own historical
  ceiling of 8 (not enforced strictly in code — a soft recommendation via
  the "up to 8" framing, not a blocking validation. **Open point for the
  implementation plan to confirm**: whether to add a hard 8-photo cap per
  cell or leave it unbounded. Recommendation: hard cap at 8 for consistency
  with the existing data shape's expectations.)

## Error handling

| Failure | Behavior |
|---|---|
| File > 10MB | Inline per-photo error, photo not added, rest of form unaffected |
| Compression throws (corrupt/unsupported file) | Inline per-photo error, same as above |
| `upload-signature` request fails | Submit aborts before any Cloudinary call; "couldn't prepare upload, try again" |
| Any Cloudinary upload in the batch fails | Submit aborts; no call to `POST /catalog/products`; user sees which photo(s) failed, can remove/retry and resubmit |
| `POST /catalog/products` fails after uploads succeeded | Accepted orphan risk (uploaded-but-unused Cloudinary assets) — explicit trade-off of the batch-on-submit approach over upload-then-cleanup |

## Testing plan

- **Backend unit tests**: `upload-signature` endpoint (role gating matches
  `POST /catalog/products`; signature is deterministic given fixed inputs
  and verifiable against Cloudinary's own signing algorithm).
  `ProductCreationService` — photoUrls land on the correct
  `WarehouseVariant` per matrix cell; `ColourVariant.photoUrl` backfills only
  when previously null, never overwritten.
- **Frontend unit tests**: compression pipeline (mock
  `browser-image-compression`; verify 10MB reject / ~3MB target thresholds
  are wired correctly), the device-gating hook (breakpoint boundary,
  resize/orientation-change re-evaluation).
- **Manual verification**: real tablet/phone browser pass (per the `run`
  skill) covering camera capture end-to-end — this cannot be meaningfully
  covered by a headless browser test.

## Rollout notes

- `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` /
  `CLOUDINARY_UPLOAD_FOLDER` already present in `.env` (local, filled in) and
  documented in `.env.example`. Production deploy needs the same three
  secrets added wherever `docs/DEPLOY.md` tracks owner-gated credentials —
  update that table as part of implementation.
- No database migration required.
