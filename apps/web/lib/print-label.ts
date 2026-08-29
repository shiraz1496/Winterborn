/// Scope `window.print()` to a single DOM subtree — the box QR label —
/// without dragging the surrounding page along.
///
/// Adds the `.print-target` class to the target element and
/// `.is-printing-label` to `<body>`, calls `window.print()`, and undoes
/// both after the print dialog closes. The paired CSS lives in
/// globals.css inside `@media print { body.is-printing-label { ... } }`
/// — that rule hides every other element in the tree via
/// `visibility: hidden` and absolute-positions the target so it prints
/// on its own.
export function printLabelElement(elementId: string): void {
  const el = document.getElementById(elementId)
  if (!el) return

  el.classList.add('print-target')
  document.body.classList.add('is-printing-label')

  const cleanup = () => {
    el.classList.remove('print-target')
    document.body.classList.remove('is-printing-label')
    window.removeEventListener('afterprint', cleanup)
  }
  // `afterprint` fires reliably in every current browser once the
  // print dialog is closed (accepted or cancelled). No timeout
  // fallback needed — if the browser never fires it, we'd rather keep
  // the classes stuck than yank them mid-print.
  window.addEventListener('afterprint', cleanup)

  window.print()
}
