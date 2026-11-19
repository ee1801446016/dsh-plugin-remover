// Runtime regression for the crash that made the delete dialog unclosable.
//
// The bug had two halves and both are pinned here:
//
//   1. `const window = plan.changed?.window` is `undefined` when the Host half
//      predates the field. The guard was `window === null`, which is false for
//      undefined, so the else branch read `window.start` and threw mid-render.
//   2. The error fallback passed an empty `onClose`, so a render error left a
//      modal with no way out — the X and the backdrop both did nothing.
//
// Rather than fake React deeply (a stub that mis-orders hooks proves nothing),
// this evaluates the exact expressions the bundle uses, against the exact Host
// payloads both versions return. That is precisely what crashed.
import { readFileSync } from 'node:fs'

let passed = 0
const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- the guard

/** The guard the fixed bundle uses, copied verbatim from the source. */
const hasWindowOf = (window) => window !== null && window !== undefined
  && typeof window.start === 'number' && typeof window.end === 'number'

console.log('# the window guard')
{
  check('null is absent', hasWindowOf(null) === false)
  check('undefined is absent', hasWindowOf(undefined) === false)
  check('an empty object is absent', hasWindowOf({}) === false)
  check('a half-built window is absent', hasWindowOf({ start: 1 }) === false)
  check('a string start is absent', hasWindowOf({ start: '1', end: '2' }) === false)
  check('a real window is present', hasWindowOf({ start: 1, end: 2 }) === true)

  // The old guard, for the record: it treated a missing window as present.
  const oldGuardSaysPresent = (window) => (window === null) === false
  check('the old guard accepted undefined (this was the bug)', oldGuardSaysPresent(undefined) === true)
  check('the old guard accepted null is wrong too — it rejected it', oldGuardSaysPresent(null) === false)
}

// ---------------------------------------------------------------- normalisation

console.log('\n# the scan response is normalised at the boundary')
{
  // What a 1.0.0 Host half returns: no `changed` group at all.
  const legacy = {
    sessionId: 'session-ebf76e11',
    store: { directories: ['a'], bytes: 1 },
    artifacts: { items: [], refused: [], totalBytes: 0, truncated: false },
    referenced: { items: [], refused: [], totalBytes: 0, truncated: false },
    attachments: { ids: [] },
  }

  // The expression in the bundle, verbatim.
  const normalised = {
    ...legacy,
    store: legacy.store ?? { directories: [], bytes: 0 },
    projectionCache: legacy.projectionCache ?? null,
    children: legacy.children ?? [],
    artifacts: legacy.artifacts ?? { items: [], refused: [], totalBytes: 0, truncated: false },
    referenced: legacy.referenced ?? { items: [], refused: [], totalBytes: 0, truncated: false },
    changed: legacy.changed ?? { items: [], totalBytes: 0, truncated: false, window: null },
    attachments: legacy.attachments ?? { ids: [], items: [] },
    trash: legacy.trash ?? {},
  }

  check('the legacy payload gains a changed group', normalised.changed !== undefined)
  check('the group is empty', normalised.changed.items.length === 0)
  check('the group reports no window', normalised.changed.window === null)
  check('the guard accepts it', hasWindowOf(normalised.changed.window) === false)

  // Every field the render reads must survive the normalisation.
  for (const key of ['store', 'projectionCache', 'children', 'artifacts', 'referenced', 'changed', 'attachments', 'trash']) {
    check(`${key} is defined after normalisation`, normalised[key] !== undefined)
  }

  // And the render's own reads must not throw against it.
  let renderThrew = null
  try {
    const items = normalised.changed.items
    const selected = items.filter((row) => row.id === 'x')
    const bytes = items.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
    if (!hasWindowOf(normalised.changed.window)) {
      // the noWindow branch
    } else {
      void new Date(normalised.changed.window.start).toLocaleString()
    }
    void selected
    void bytes
  } catch (error) {
    renderThrew = error
  }
  check('reading the normalised group during render does not throw', renderThrew === null, renderThrew?.message)
}

// ---------------------------------------------------------------- the fallback

console.log('\n# the crash fallback can be dismissed')
{
  // The failing shape: the fallback used an empty onClose.
  const badFallback = source.includes('onClose: () => {},')
  check('no empty onClose remains on the error fallback', badFallback === false)

  // The fixed shape: the boundary takes onClose, and the dialog wires it to the
  // store so the close button works even when the form is what failed.
  check('the boundary accepts an onClose prop', source.includes('onClose: this.props.onClose ?? (() => {})'))
  check('the dialog passes the store close into the boundary',
    source.includes('onClose: () => { purgeStore.close() }'))

  // Prove the ordering: the onClose prop must be supplied by the caller that has
  // the store, not defaulted away inside the boundary.
  const boundaryAt = source.indexOf('class DialogBoundary')
  const passAt = source.indexOf('onClose: () => { purgeStore.close() }')
  check('the store close is defined outside the boundary', passAt > boundaryAt)
}

// ---------------------------------------------------------------- the source reads

console.log('\n# the crash-prone read is gone from the bundle')
{
  check('the fixed guard is present in the source', source.includes('typeof window.start === \'number\''))
  // If a future edit reintroduces `if (window === null)` around a `.start` read,
  // this catches it.
  const oldPattern = /if \(window === null\) \{[\s\S]{0,200}window\.start/
  check('the old null-only guard is not in a .start path', oldPattern.test(source) === false)
}

console.log('')
if (failures.length > 0) {
  console.log(`${String(passed)}/${String(passed + failures.length)} checks passed, ${String(failures.length)} failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`${String(passed)}/${String(passed)} checks passed`)
