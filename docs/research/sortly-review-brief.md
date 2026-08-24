# Sortly review brief (for a browser agent)

Paste everything below into the extension.

---

## ⛔ READ-ONLY. This is the most important instruction.

You are inspecting a **live production warehouse system belonging to a paying client**. There is no undo.

**Never click, tap or submit any of these:** Add, New, Create, Save, Update, Edit, Delete, Archive, Move, Duplicate, Adjust, Receive, Transfer, Import, Export-and-email, Invite, or anything in Settings or Billing.

**If a form opens, do not fill it. Read the field labels, then press Cancel or Escape.**

**If you are unsure whether an action writes, do not do it.** Note it as "not checked, would have required a write" and move on. An incomplete report is fine. A modified client record is not.

You may: navigate, scroll, search, open items and folders to view them, switch between list and detail views, resize the window, and take screenshots.

---

## Why this review exists

The client runs 14 US Christmas-market retail locations. Sortly is their warehouse inventory system and we are **replacing it** with a system we have already built. It holds roughly 564 items and 42,000 units.

We already have a full CSV export of the data, so **do not catalogue the data**. What we need is everything the export cannot tell us: **how the screens work, what the workflows are, and which fields and behaviours exist that the export does not show.**

The person who uses this daily is a warehouse lead. She is standing at a bench, often on a phone, receiving stock and recording it. Speed and tap-count matter.

---

## Priority 1: answer this one question first

**When a quantity changes, does Sortly record a movement, or overwrite a number?**

- A **movement** looks like "+10 received" or "-3 damaged", and leaves a history entry.
- An **overwrite** looks like a quantity box you type `50` into, replacing whatever was there.

How to determine this **without writing anything**:

1. Open any item's detail view. Look at the quantity control. Does it offer +/- buttons, or a single editable number? Read the button labels exactly and quote them.
2. Look for an **activity log, history, or audit trail** on the item or in the account. If past changes are listed, read a few and describe their wording: does an entry say "changed from 40 to 50", or "added 10"?
3. Screenshot both.

This determines how we build our intake screen, so be precise and quote the actual UI text.

---

## Priority 2: fields and structure

Open two or three item detail pages and record:

- **Every field shown**, with its exact label, and whether it looks required
- **Attributes**: the client uses `Color`, `Style`, `Size`. Are these dropdowns, autocomplete, or free text? Can a user type a brand new value inline? *(This matters a lot: their data contains both "Grey" and "Gray", which suggests free text.)*
- Any field that is **not** one of these, which are the ones we already have from the export:
  `Entry Name, Entry Type, SID, Item Group Name, Attribute 1-3 Name/Option, Quantity, Unit, Min Level, Price, Value, Notes, Tags, Primary Folder, Subfolder level 1-4, Photo 1-8, Barcode/QR data and type, Location`
- **Tags** and **Notes**: find an item that has them and describe what they appear to be used for
- **Min Level**: is there any visible low-stock warning, badge, or notification setting?
- **Photos**: how many per item, is there a primary, how are they arranged
- **Item Group vs Item**: how does the UI express that relationship? Is a group a folder, a parent item, or a label?

---

## Priority 3: the three workflows

**Walk up to each one and stop before submitting.** Open the form, read it, screenshot it, cancel.

1. **Add a new item.** How many fields? Which are required? Is it one screen or several steps? Roughly how many taps to complete?
2. **Receive more of an existing item.** This is the workflow used most. Where is it, what is the control called, what does it ask for?
3. **Find an item.** What search exists? Does it search names only, or attributes too? Is there a barcode-scan option? *(All 564 items have empty barcode fields, so scanning is probably unused — confirm from the UI.)*

For each: quote the button labels and screenshot the form.

---

## Priority 4: mobile

Then repeat the key parts on a **narrow viewport** (resize to roughly 390 x 844, iPhone-sized) or the mobile site if one exists.

- Does the layout change meaningfully, or is it the same screens squeezed?
- Is photo capture part of the add-item flow, or a separate step?
- Is there a barcode scanner control?
- Are the tap targets usable one-handed?
- Anything present on mobile that is absent on web, or vice versa

Note: you are in a browser, so you cannot test the native app. Say so explicitly rather than guessing at native behaviour.

---

## What to produce

A single markdown document with these sections:

1. **The movement-vs-overwrite answer**, with the exact UI text you based it on
2. **Field inventory** — every field seen, and a clearly marked list of any field *not* in the export list above
3. **Attribute entry behaviour** — dropdown, autocomplete or free text, and whether new values can be created inline
4. **The three workflows**, each with field list, button labels, step count and a screenshot
5. **Web vs mobile differences**
6. **Anything you could not check because it would have required a write** — list these plainly, they are useful
7. **Your honest view**: what would the warehouse lead miss most if Sortly disappeared tomorrow?

Screenshot generously. Quote UI text exactly rather than paraphrasing. Where you are guessing, say you are guessing.

Do not summarise the inventory data itself. We have it.
