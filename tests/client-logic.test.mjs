/**
 * The settings page's rules, without a browser.
 *
 * `src/client/logic.js` holds every decision the section makes; the React half
 * is only pixels and promise plumbing. That split is what lets this file pin the
 * page's behaviour with bare `node --test` — no DOM engine, no jsdom, no
 * browser. `tests/client-bundle.test.mjs` covers the other half (that the built
 * bundle registers and materializes).
 *
 * @module tests/client-logic
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  activateSubscription,
  activationWriteOps,
  addModelById,
  addSubscriptionRow,
  balanceCells,
  blankExtraDraft,
  capabilityChips,
  catalogueView,
  capacityPlaceholder,
  deepEqual,
  defaultRowHidden,
  describeFailure,
  describeSync,
  diagnosticsView,
  directoryRows,
  effectiveIds,
  errorPathsOf,
  mintSubscriptionId,
  modelSourceLine,
  replacementSuggestions,
  syncProgressText,
  syncTargetIds,
  formFromView,
  formatTokenCount,
  isConflictFailure,
  isDirty,
  isHeaderToken,
  isModelEnabled,
  isUsableApiKey,
  legacyApiKeyPresent,
  looksLikeSecretValue,
  modalityPlaceholder,
  modelsBlockFrom,
  modelsWriteOps,
  namespaceView,
  patchDirectoryRow,
  patchSubRow,
  preserveDraftScalars,
  removeSubRow,
  resetPhrase,
  resetShort,
  resetStamp,
  primaryErrorPath,
  removeDirectoryRow,
  restoreDefaultRow,
  revisionFor,
  rowIndexFor,
  setModelSelection,
  stagedCredentialPlanFor,
  stagedCredentialPlans,
  subscriptionSlotOf,
  subscriptionSlots,
  subsBlockFrom,
  usageView,
  unwrapPayload,
  validateForm,
  writeOps,
} from '../src/client/logic.js'
import { DEFAULT_SUB_ID, normalizeSubscriptions, refForSubscriptionLabel } from '../src/subs.js'

/** The sentinel the credential fixture stages — never a real key. */
const STAGED = 'sk-SENTINEL-not-a-real-key'
/** A legacy plain-text token, as a pre-0.6.0 document stored it. */
const LEGACY = 'sk-LEGACY-not-a-real-key'

/** One `SettingsNamespaceView`-shaped fixture, as `settings.describe()` returns it. */
function viewOf({ value = {}, user, revision = 7 } = {}) {
  return {
    ns: 'opencode-go-native',
    schema: {},
    value: { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', sessionHeaderEnabled: true, sessionHeaderMode: 'session-id', sync: true, ...value },
    ...user === undefined ? {} : { user },
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** One catalogue entry as `GET /opencode-go-native/models` answers it. */
function modelOf(id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: 'openai-completions',
    protocolSource: 'models.dev-npm',
    snapshotKnown: true,
    defaults: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    effective: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    ...overrides,
  }
}

// ── reading the host's payload ─────────────────────────────────────────────

test('namespaceView finds our namespace and refuses to guess', () => {
  assert.equal(namespaceView({ namespaces: [{ ns: 'other' }, { ns: 'opencode-go-native', revision: 3 }] }).revision, 3)
  assert.equal(namespaceView({ namespaces: [{ ns: 'other' }] }), undefined)
  assert.equal(namespaceView(undefined), undefined)
  assert.equal(namespaceView({ namespaces: 'nope' }), undefined)
})

test('formFromView prefers the user layer for scalars and the user models block verbatim', () => {
  const form = formFromView(viewOf({
    value: { baseURL: 'https://from-resolved/v1', displayName: 'resolved-name' },
    user: { baseURL: 'https://from-user/v1', models: { disabled: ['retired'], extra: [{ id: 'hand' }], overrides: {}, replaceDiscovered: false } },
  }))
  assert.equal(form.baseURL, 'https://from-user/v1')
  // Not in the user layer, so the resolved (inherited) value is shown.
  assert.equal(form.displayName, 'resolved-name')
  assert.deepEqual(form.disabled, ['retired'])
  assert.equal(form.extra.length, 1)
  assert.equal(form.extra[0].id, 'hand')
  assert.equal(form.sessionHeaderMode, 'session-id')
  assert.equal(form.sessionHeaderEnabled, true)
})

test('formFromView survives a value layer that carries no models block at all', () => {
  const form = formFromView(viewOf({ value: {} }))
  assert.deepEqual(form.disabled, [])
  assert.deepEqual(form.extra, [])
  assert.deepEqual(form.overrides, [])
  // The SHIPPED default, kept in step with src/config.js: a fresh install loads
  // no models. Rendering it as false would say "everything is enabled" while the
  // route actually serves nothing.
  assert.equal(form.replaceDiscovered, true)
})

test('there is no top-level key cell any more; every row\'s staging field starts blank', () => {
  // The redesign moved the write-only key cell onto the subscription rows: a
  // secret is never rendered back, and the top of the page is the list itself —
  // not a second, parallel "the key" field.
  for (const view of [
    viewOf({ user: { apiKey: LEGACY } }),
    { ...viewOf({ user: {} }), secrets: [{ path: ['apiKey'], set: true }] },
  ]) {
    const form = formFromView(view)
    assert.equal('apiKey' in form, false, 'the legacy top-level staging cell is gone')
    assert.ok(form.subscriptions.length > 0, 'the default row always exists')
    for (const row of form.subscriptions) {
      assert.equal(row.apiKey, '', 'the row staging field must never be pre-filled from the host')
    }
  }
})

test('legacyApiKeyPresent reports the pre-0.6.0 state from every spelling the read can take', () => {
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['apiKey'], set: true }] }), true)
  assert.equal(legacyApiKeyPresent(viewOf({ user: { apiKey: LEGACY } })), true)
  assert.equal(legacyApiKeyPresent(viewOf({ value: { apiKey: LEGACY } })), true)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['apiKey'], set: false }] }), false)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['apiKeyEnv'], set: true }] }), false)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: [{ path: ['models', 'apiKey'], set: true }] }), false)
  assert.equal(legacyApiKeyPresent({ ...viewOf({ user: {} }), secrets: 'not-an-array' }), false)
})

test('revisionFor sends the host revision back, and undefined when there is none', () => {
  assert.equal(revisionFor({ revision: 12 }), 12)
  assert.equal(revisionFor({ revision: undefined }), undefined)
  assert.equal(revisionFor({ revision: '12' }), undefined)
})

// ── form ↔ config ──────────────────────────────────────────────────────────

test('extra serialization omits every blank cell instead of inventing a pin', () => {
  const block = modelsBlockFrom({
    disabled: [],
    replaceDiscovered: false,
    overrides: [],
    extra: [{ key: 'k', id: ' my-model ', name: ' My Model ', api: '', contextWindow: '', maxTokens: 4096, input: [], reasoning: undefined, reasoningEfforts: [] }],
  })
  assert.deepEqual(block.extra, [{ id: 'my-model', name: 'My Model', maxTokens: 4096 }])
})

test('extra serialization keeps every claim the operator did make', () => {
  const [entry] = modelsBlockFrom({
    extra: [{
      key: 'k', id: 'hand-declared', name: 'Hand', api: 'openai-responses',
      contextWindow: 131072, maxTokens: 16384, input: ['text', 'image'],
      reasoning: true, reasoningEfforts: ['low', 'high'],
    }],
  }).extra
  assert.deepEqual(entry, {
    id: 'hand-declared',
    name: 'Hand',
    api: 'openai-responses',
    contextWindow: 131072,
    maxTokens: 16384,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: ['low', 'high'],
  })
})

test('a half-typed row (no id yet) is not written', () => {
  const block = modelsBlockFrom({ extra: [blankExtraDraft('draft')], disabled: [], overrides: [], replaceDiscovered: false })
  assert.deepEqual(block.extra, [])
})

test('an override that claims nothing is dropped from the write, not written empty', () => {
  const block = modelsBlockFrom({
    overrides: [
      { id: 'glm-5.3-flash', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] },
      { id: 'other', api: '', contextWindow: 4096, maxTokens: '', input: [], reasoningEfforts: [] },
    ],
  })
  assert.deepEqual(block.overrides, { other: { contextWindow: 4096 } })
})

test('a form round-trips through the host section shape byte-for-byte', () => {
  const user = {
    models: {
      disabled: ['retired-model'],
      extra: [{ id: 'hand-declared', name: 'Hand Declared', api: 'openai-responses', contextWindow: 4096 }],
      overrides: { 'glm-5.3-flash': { contextWindow: 4096 } },
      replaceDiscovered: false,
    },
  }
  const form = formFromView(viewOf({ user }))
  assert.deepEqual(modelsBlockFrom(form), user.models)
})

// ── the model directory ────────────────────────────────────────────────────

test('directoryRows joins the catalogue with the overlay, and a disabled model simply has no row', () => {
  const form = formFromView(viewOf({
    user: {
      models: {
        disabled: ['retired'],
        extra: [{ id: 'hand', name: 'Hand' }],
        overrides: { alpha: { contextWindow: 4096 } },
        replaceDiscovered: false,
      },
    },
  }))
  const rows = directoryRows(form, [modelOf('alpha'), modelOf('retired')])
  assert.deepEqual(rows.map((row) => row.id), ['alpha', 'hand'])
  assert.equal(rows[0].advertised, true)
  assert.equal(rows[0].override.contextWindow, 4096)
  assert.equal(rows[0].defaults.contextWindow, 1_000_000, 'the official default is carried for the placeholders')
  assert.equal(rows[1].advertised, false)
  assert.equal(rows[1].name, 'Hand')
  assert.equal(rows[1].extra.id, 'hand')
})

test('a legacy blank row is kept for display but never written', () => {
  // The page no longer creates blank rows; a pre-0.7.0 document could still hold
  // one. It renders (the operator's typing is not thrown away) and serializes to
  // nothing (`extraEntryFrom` drops id-less rows), so it self-heals on the next
  // write.
  const form = formFromView(viewOf({ user: { models: { disabled: [], extra: [{ id: '' }], overrides: {}, replaceDiscovered: false } } }))
  const rows = directoryRows(form, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '')
  assert.deepEqual(modelsBlockFrom(form).extra, [])
})

test('removing an advertised row excludes it and strips its declarations; removing a hand row just drops it', () => {
  const form = formFromView(viewOf({
    user: {
      models: {
        disabled: [],
        extra: [{ id: 'hand' }, { id: 'alpha', contextWindow: 4096 }],
        overrides: { alpha: { maxTokens: 2048 } },
        replaceDiscovered: false,
      },
    },
  }))
  const rows = directoryRows(form, [modelOf('alpha')])
  const alpha = rows.find((row) => row.id === 'alpha')
  const removed = removeDirectoryRow(form, alpha)
  assert.deepEqual(removed.disabled, ['alpha'])
  assert.deepEqual(removed.extra.map((row) => row.id).filter(Boolean), ['hand'])
  assert.deepEqual(Object.keys(modelsBlockFrom(removed).overrides), [])
  // The host refuses a disabled model that still carries extra/override, so both
  // must be gone.
  assert.equal(modelsBlockFrom(removed).extra.some((row) => row.id === 'alpha'), false)

  const hand = rows.find((row) => row.id === 'hand')
  const dropped = removeDirectoryRow(form, hand)
  assert.deepEqual(dropped.disabled, [])
  assert.deepEqual(dropped.extra.map((row) => row.id).filter(Boolean), ['alpha'])
})

test('patching an advertised row writes an override; patching a hand row writes the declaration', () => {
  const base = formFromView(viewOf({ user: { models: { disabled: [], extra: [{ id: 'hand' }], overrides: {}, replaceDiscovered: false } } }))
  const [hand] = directoryRows(base, [])
  const withName = patchDirectoryRow(base, hand, { name: 'Nice Name', contextWindow: 4096 })
  assert.deepEqual(withName.extra[0].name, 'Nice Name')
  assert.deepEqual(Object.keys(modelsBlockFrom(withName).overrides), [])

  const withAdvertised = directoryRows(base, [modelOf('alpha')]).find((row) => row.id === 'alpha')
  const patched = patchDirectoryRow(base, withAdvertised, { api: 'openai-responses', maxTokens: 8192 })
  assert.deepEqual(modelsBlockFrom(patched).overrides.alpha, { api: 'openai-responses', maxTokens: 8192 })
  assert.deepEqual(modelsBlockFrom(patched).extra, [{ id: 'hand' }], 'the advertised row is not turned into an extra')

  // A correction that ends up claiming nothing must not survive as an empty row.
  const cleared = patchDirectoryRow(patched, { ...withAdvertised, override: patched.overrides[0] }, { maxTokens: undefined, api: '' })
  assert.deepEqual(modelsBlockFrom(cleared).overrides, {})
})

test('setModelSelection applies the checked-set over the listing and keeps untouched ids alone', () => {
  const form = formFromView(viewOf({
    user: { models: { disabled: ['alpha', 'ghost'], extra: [{ id: 'hand' }], overrides: { alpha: { maxTokens: 1 } }, replaceDiscovered: false } },
  }))
  // The listing shows alpha and ghost; `hand` and any older exclusion are NOT
  // in the listing, so the operation must not speak for them.
  const candidates = [modelOf('alpha'), modelOf('ghost')]
  const applied = setModelSelection(form, candidates, ['alpha'])
  // alpha re-enabled (its exclusion cleared, its claim kept); ghost unchecked →
  // excluded; the hand row and its exclusion of nothing are untouched.
  assert.deepEqual(applied.disabled, ['ghost'])
  assert.deepEqual(Object.keys(modelsBlockFrom(applied).overrides), ['alpha'])
  assert.deepEqual(modelsBlockFrom(applied).extra.map((row) => row.id), ['hand'])
})

test('setModelSelection strips claims on a model the selection turned off', () => {
  const form = formFromView(viewOf({
    user: {
      models: {
        disabled: [],
        extra: [{ id: 'alpha', contextWindow: 4096 }, { id: 'ghost' }],
        overrides: { alpha: { maxTokens: 2048 }, beta: { api: 'openai-responses' } },
        replaceDiscovered: false,
      },
    },
  }))
  // alpha is listed and UNCHECKED; it is endpoint+extra, so both its rows of
  // claims must go (the host refuses claims on an excluded model). beta is not
  // in the listing: its claim, and everything about ghost, stay.
  const applied = setModelSelection(form, [modelOf('alpha'), modelOf('delta')], ['delta'])
  assert.ok(applied.disabled.includes('alpha'))
  assert.deepEqual(modelsBlockFrom(applied).extra.map((row) => row.id), ['ghost'])
  assert.deepEqual(Object.keys(modelsBlockFrom(applied).overrides), ['beta'])
})

test('setModelSelection leaves replaceDiscovered exactly as stored (the page never touches it)', () => {
  const form = formFromView(viewOf({ user: { models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: true } } }))
  const applied = setModelSelection(form, [modelOf('alpha')], ['alpha'])
  assert.equal(applied.replaceDiscovered, true)
})

test('addModelById enables an advertised id by clearing its exclusion, and declares only what the endpoint lacks', () => {
  const form = formFromView(viewOf({ user: { models: { disabled: ['alpha', 'beta'], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const advertised = ['alpha', 'delta']
  const enabled = addModelById(form, ' alpha ', advertised)
  assert.deepEqual(enabled.disabled, ['beta'], 'the advertised id needs no declaration; clearing its exclusion IS the activation')
  assert.deepEqual(modelsBlockFrom(enabled).extra, [])

  const declared = addModelById(enabled, 'beta', advertised)
  assert.deepEqual(declared.disabled, [])
  const extra = modelsBlockFrom(declared).extra
  assert.deepEqual(extra.map((row) => row.id), ['beta'], 'a not-advertised id becomes a declaration')
  assert.equal(extra[0].contextWindow, undefined, 'no capacity is pinned: the official facts stay inherited')

  // Adding what is already enabled/declared changes nothing.
  assert.deepEqual(modelsBlockFrom(addModelById(declared, 'beta', advertised)), modelsBlockFrom(declared))
  assert.deepEqual(modelsBlockFrom(addModelById(declared, '   ', advertised)), modelsBlockFrom(declared))
})

// ── the credential plan ────────────────────────────────────────────────────

test('stagedCredentialPlans plans EVERY row that staged a key, to that row\'s derived slot', () => {
  const form = formFromView(viewOf({ user: { subscriptions: [{ id: 'work', label: '公司号' }] } }))
  assert.deepEqual(stagedCredentialPlans(form), [], 'nothing staged, nothing to write')

  // The DEFAULT row is no exception: it owns a derived slot like every other
  // row (`OPENCODE_GO_DEFAULT`), and its plan is reported under that reference.
  const stagedDefault = patchSubRow(form, 'default', { apiKey: `  ${STAGED}  ` })
  assert.deepEqual(stagedCredentialPlans(stagedDefault), [
    { reference: 'OPENCODE_GO_DEFAULT', value: STAGED, label: 'OPENCODE_GO_DEFAULT', key: 'default' },
  ])

  const both = patchSubRow(stagedDefault, 'work', { apiKey: 'sk-work-0123456789' })
  assert.deepEqual(stagedCredentialPlans(both), [
    { reference: 'OPENCODE_GO_DEFAULT', value: STAGED, label: 'OPENCODE_GO_DEFAULT', key: 'default' },
    { reference: 'OPENCODE_GO_WORK', value: 'sk-work-0123456789', label: '公司号', key: 'work' },
  ])

  // A row with no name yet has no derived slot, so a key typed into it stays a
  // draft (it cannot be written to a slot that does not exist yet).
  const blankForm = addSubscriptionRow(formFromView(viewOf({ user: {} })))
  const orphan = patchSubRow(blankForm, blankForm.subscriptions[1].key, { apiKey: STAGED })
  assert.deepEqual(stagedCredentialPlans(orphan), [])
})

// ── validation ─────────────────────────────────────────────────────────────

test('isHeaderToken follows RFC 7230 tokens', () => {
  for (const good of ['x-opencode-session', 'X-Session', 'a!#$%&\'*+.^_`|~']) {
    assert.equal(isHeaderToken(good), true, good)
  }
  for (const bad of ['x session', 'x:session', 'x\nsession', '', '会话', 'x/session']) {
    assert.equal(isHeaderToken(bad), false, JSON.stringify(bad))
  }
})

test('looksLikeSecretValue catches a pasted key but not a variable name', () => {
  assert.equal(looksLikeSecretValue('OPENCODE_GO_API_KEY'), false)
  assert.equal(looksLikeSecretValue('MY_KEY_2'), false)
  assert.equal(looksLikeSecretValue('sk-abcdefghijklmnopqrstuvwxyz0123456789'), true)
  assert.equal(looksLikeSecretValue('a'.repeat(40)), true)
  assert.equal(looksLikeSecretValue(undefined), false)
})

test('isUsableApiKey refuses what no HTTP header could carry', () => {
  assert.equal(isUsableApiKey(STAGED), true)
  assert.equal(isUsableApiKey('   '), false)
  assert.equal(isUsableApiKey('sk-a\nb'), false)
  assert.equal(isUsableApiKey(undefined), false)
})

test('validateForm names the control for every client-detectable mistake', () => {
  const errors = validateForm({
    baseURL: 'ftp://nope',
    apiKeyEnv: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    sessionHeader: 'x session',
    sessionHeaderEnabled: true,
    sessionHeaderMode: 'session-id',
    extra: [
      { id: '', api: 'openai-chat', contextWindow: -5, maxTokens: 0, input: ['video'], reasoningEfforts: ['off'] },
      { id: 'dup', api: 'openai-responses', contextWindow: 1, maxTokens: '', input: [], reasoningEfforts: [] },
      { id: 'dup', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] },
    ],
    disabled: ['dup', 'dup'],
    overrides: [
      { id: 'dup', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] },
      { id: 'dup', api: '', contextWindow: 4096, maxTokens: '', input: [], reasoningEfforts: [] },
    ],
    replaceDiscovered: false,
    // The staged key lives on a subscription ROW now (here the default one).
    subscriptions: [{
      key: 'default', isDefault: true, id: 'default', label: '', apiKeyRef: 'OPENCODE_GO_API_KEY',
      apiKey: 'sk-with\nnewline',
    }],
    activeSubscription: 'default',
  })
  assert.equal(errors.baseURL, '必须以 http:// 或 https:// 开头')
  // The reference field is a NAME; a pasted key there would leave the runtime
  // reading an unset variable while the secret sits in the settings document.
  assert.match(errors.apiKeyEnv, /引用名只能填环境变量名/u)
  // The staged credential value must be a value a header could carry.
  assert.match(errors['subscriptions[0].apiKey'], /控制字符|换行/u)
  assert.match(errors.sessionHeader, /RFC 7230/u)
  assert.match(errors['models.extra[0].id'], /必填/u)
  assert.match(errors['models.extra[0].api'], /不受支持的协议/u)
  assert.match(errors['models.extra[0].contextWindow'], /正整数/u)
  assert.match(errors['models.extra[0].maxTokens'], /正整数/u)
  assert.match(errors['models.extra[0].input'], /text \/ image/u)
  assert.match(errors['models.extra[0].reasoningEfforts'], /off 用“关闭推理”表达/u)
  assert.match(errors['models.extra[2].id'], /disabled/u)
  assert.match(errors['models.disabled[1]'], /重复/u)
  assert.match(errors['models.overrides[0].id'], /什么都没写/u)
  assert.match(errors['models.overrides[1].id'], /永远不会生效/u)
})

test('validateForm requires the credential reference, the one supported source', () => {
  const base = {
    baseURL: 'https://x/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', sessionHeader: 'x-s',
    sessionHeaderEnabled: true, sessionHeaderMode: 'session-id', disabled: [], extra: [], overrides: [], replaceDiscovered: false,
  }
  assert.deepEqual(validateForm(base), {})
  assert.match(validateForm({ ...base, apiKeyEnv: '   ' }).apiKeyEnv, /必填/u)
})

test('validateForm accepts a clean draft, including a disabled header with no name', () => {
  const errors = validateForm({
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    sessionHeader: '',
    sessionHeaderEnabled: false,
    sessionHeaderMode: 'uuid',
    extra: [{ id: 'hand', api: 'openai-completions', contextWindow: 4096, maxTokens: 1024, input: ['text'], reasoningEfforts: ['low'] }],
    disabled: [],
    overrides: [{ id: 'hand', api: 'anthropic-messages', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] }],
    replaceDiscovered: false,
  })
  assert.deepEqual(errors, {})
})

// ── effective set ──────────────────────────────────────────────────────────

test('the effective set is discovered ∪ extra \\ disabled', () => {
  const base = {
    baseURL: 'https://x/v1', apiKeyEnv: 'K', sessionHeader: 'x-s', sessionHeaderEnabled: true, sessionHeaderMode: 'session-id',
    disabled: ['b'], replaceDiscovered: false, overrides: [],
    extra: [{ id: 'hand', name: '', api: '', contextWindow: '', maxTokens: '', input: [], reasoningEfforts: [] }],
  }
  assert.deepEqual(effectiveIds(base, ['a', 'b', 'c']), ['a', 'c', 'hand'])
  assert.equal(isModelEnabled('b', base, ['a', 'b']), false)
  assert.equal(isModelEnabled('a', base, ['a', 'b']), true)
  assert.equal(isModelEnabled('hand', base, ['a', 'b']), true)
  // `replaceDiscovered` is the one switch that freezes the set.
  const frozen = { ...base, replaceDiscovered: true }
  assert.deepEqual(effectiveIds(frozen, ['a', 'b', 'c']), ['hand'])
  assert.equal(isModelEnabled('c', frozen, ['c']), false)
})

// ── writes ─────────────────────────────────────────────────────────────────

test('writeOps emits nothing when the draft equals the snapshot', () => {
  const form = formFromView(viewOf({ user: { baseURL: 'https://user/v1' } }))
  assert.deepEqual(writeOps(form, form), [])
  assert.equal(isDirty(form, form), false)
  assert.equal(isDirty(form, { ...form, sync: !form.sync }), true)
})

test('writeOps writes only the fields that moved, and unsets a cleared optional', () => {
  const clean = formFromView(viewOf({ user: { baseURL: 'https://a/v1', displayName: 'A', sync: true } }))
  const draft = { ...clean, displayName: '', sync: false, baseURL: 'https://b/v1' }
  const ops = writeOps(clean, draft)
  assert.deepEqual(ops, [
    { op: 'set', path: ['baseURL'], value: 'https://b/v1' },
    { op: 'set', path: ['displayName'], value: '' },
    { op: 'set', path: ['sync'], value: false },
  ])
})

test('writeOps never carries a staged credential value: that write belongs to the credential store', () => {
  const clean = formFromView(viewOf({ user: {} }))
  const draft = patchSubRow(clean, 'default', { apiKey: STAGED })
  assert.deepEqual(writeOps(clean, draft), [], 'the settings document records slots, never secrets')
  // And a commit that only stages a key still owes the credential plan; the
  // per-row lookup is what the one-click switch uses before moving the pointer.
  assert.deepEqual(stagedCredentialPlans(draft), [
    { reference: 'OPENCODE_GO_DEFAULT', value: STAGED, label: 'OPENCODE_GO_DEFAULT', key: 'default' },
  ])
  assert.deepEqual(stagedCredentialPlanFor(draft, 'default'), {
    reference: 'OPENCODE_GO_DEFAULT', value: STAGED, label: 'OPENCODE_GO_DEFAULT', key: 'default',
  })
  assert.equal(stagedCredentialPlanFor(draft, 'work'), undefined)
})

test('writeOps writes the four models sub-shapes together when the block moved', () => {
  const clean = formFromView(viewOf({ user: { models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const draft = { ...clean, disabled: ['b'], replaceDiscovered: true, extra: [blankExtraDraft('x')] }
  draft.extra[0].id = 'hand'
  const paths = writeOps(clean, draft).map((op) => op.path.join('.'))
  assert.deepEqual(paths, ['models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered'])
})

// ── host rejection → control ───────────────────────────────────────────────

test('errorPathsOf maps the host\'s own messages onto the controls that caused them', () => {
  assert.deepEqual(
    errorPathsOf('opencode-go-native: sessionHeader "x session" is not a valid HTTP header name (only RFC 7230 token characters are allowed)'),
    ['sessionHeader'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: models.extra["broken-extra"].contextWindow must be a positive integer (got: -5)'),
    ['models.extra[broken-extra]'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: models.overrides["glm-5.3-flash"] sets nothing; remove the entry, or name one of api, contextWindow'),
    ['models.overrides[glm-5.3-flash]'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: model "x" appears in both models.extra and models.disabled; remove it from one of them'),
    ['models.disabled', 'models.extra'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: apiKeyEnv must name a credential reference'),
    ['apiKeyEnv'],
  )
  assert.deepEqual(
    errorPathsOf('opencode-go-native: baseURL must be an absolute http(s) URL including the /v1 prefix'),
    ['baseURL'],
  )
})

test('primaryErrorPath picks the most specific control named', () => {
  assert.equal(
    primaryErrorPath('opencode-go-native: models.extra[1].api is not a protocol this build can dispatch'),
    'models.extra[1]',
  )
  assert.equal(primaryErrorPath('something entirely unrelated'), undefined)
  assert.equal(primaryErrorPath(undefined), undefined)
})

test('rowIndexFor resolves both the index and the model-id spelling to one row', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  assert.equal(rowIndexFor(rows, '1'), 1)
  assert.equal(rowIndexFor(rows, 'b'), 1)
  assert.equal(rowIndexFor(rows, 'missing'), -1)
  assert.equal(rowIndexFor([{ id: ' x ' }], 'x'), 0)
})

test('describeFailure and isConflictFailure read a Remote failure without inventing one', () => {
  assert.equal(describeFailure({ code: 'settings/rejected', message: 'boom' }), 'settings/rejected: boom')
  assert.equal(describeFailure('plain'), 'plain')
  assert.equal(describeFailure(undefined), '未知错误')
  assert.equal(isConflictFailure({ code: 'settings/conflict', message: 'x' }), true)
  assert.equal(isConflictFailure(new Error('settings namespace "ns" changed since it was read (expected revision 1, now 2)')), true)
  assert.equal(isConflictFailure({ code: 'settings/rejected', message: 'nope' }), false)
})

// ── diagnostics / catalogue payloads ───────────────────────────────────────

test('unwrapPayload throws the route\'s own error text', () => {
  assert.deepEqual(unwrapPayload({ ok: true, models: [] }), { ok: true, models: [] })
  assert.throws(() => unwrapPayload({ ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'no value for "X"' } }), (error) => {
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /no value for "X"/u)
    return true
  })
  assert.throws(() => unwrapPayload('<html>'), /不是 JSON 对象/u)
})

test('diagnosticsView refuses an SPA fallback and reads the real payload', () => {
  assert.throws(
    () => diagnosticsView({ ok: true, diagnostics: { kind: '<html>' } }),
    (error) => error.code === 'kind-mismatch',
  )
  const view = diagnosticsView({
    ok: true,
    diagnostics: {
      kind: 'dsh-opencodego/diagnostics',
      at: 1,
      connection: { baseURL: 'https://x/v1', apiKeyEnv: 'K', legacyInlineKey: true },
      configuration: { models: { protocolOverridesShadowed: ['a'] } },
      catalogue: { status: 'ok', discovered: 3, effective: 2, sources: [{ id: 'a', source: 'endpoint' }] },
      health: { rows: [{ modelId: 'a', category: 'ok' }], unusable: [], summaryLines: ['a: ok'] },
      log: { lines: [{ level: 'warn', message: 'w' }], warnings: [{ level: 'warn', message: 'w' }] },
    },
  })
  assert.equal(view.connection.apiKeyEnv, 'K')
  assert.equal(view.connection.legacyInlineKey, true)
  assert.equal(view.catalogue.effective, 2)
  assert.equal(view.health.length, 1)
  assert.equal(view.warnings.length, 1)
  assert.deepEqual(view.configuration.models.protocolOverridesShadowed, ['a'])
})

test('catalogueView reads the model-state defaults and tolerates an older payload', () => {
  const view = catalogueView({
    ok: true,
    source: 'endpoint',
    models: [
      modelOf('a'),
      { id: 'legacy', name: 'Legacy', inputModalities: ['text', 'image'], input: 'nope' },
      { nope: 1 },
    ],
  })
  assert.equal(view.source, 'endpoint')
  assert.equal(view.models.length, 2)
  assert.deepEqual(view.models[0].defaults, { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] })
  // An older host answered `inputModalities` with no `defaults` block; the row
  // must still be usable rather than throwing.
  assert.deepEqual(view.models[1].defaults, { contextWindow: undefined, maxTokens: undefined, input: [], reasoning: false, reasoningEfforts: [] })
  assert.deepEqual(view.models[1].effective.input, ['text', 'image'])
})

test('the capacity and modality placeholders show the value in EFFECT now', () => {
  assert.equal(capacityPlaceholder(1_000_000, '默认'), '当前生效 1000000')
  assert.equal(capacityPlaceholder(undefined, '默认'), '默认')
  assert.equal(capacityPlaceholder(0, '默认'), '默认')
  assert.equal(modalityPlaceholder({ input: ['text', 'image'] }), '当前生效：text + image')
  assert.equal(modalityPlaceholder({ input: [] }), '默认')
})

// ── the effective facts, shown without expanding anything ──────────────────

test('formatTokenCount writes catalog-style sizes', () => {
  assert.equal(formatTokenCount(1_000_000), '1M')
  assert.equal(formatTokenCount(1_500_000), '1.5M')
  assert.equal(formatTokenCount(384_000), '384K')
  assert.equal(formatTokenCount(202_752), '203K')
  assert.equal(formatTokenCount(128), '128')
  assert.equal(formatTokenCount(undefined), undefined)
  assert.equal(formatTokenCount(0), undefined)
})

test('capabilityChips shows the EFFECTIVE facts — the numbers dsh loads, corrections included', () => {
  const labels = capabilityChips(modelOf('a')).map((chip) => chip.label)
  assert.deepEqual(labels, [
    'openai-completions', '上下文 1M', '输出 131K', '输入 text+image', '思考 low/high',
  ])
  // A saved correction is reflected: the chip shows what the route WOULD use,
  // not the untouched built-in state.
  const corrected = capabilityChips({ ...modelOf('b'), effective: { contextWindow: 4096, maxTokens: 1024, input: ['text'], reasoning: false, reasoningEfforts: [] } })
    .map((chip) => chip.label)
  assert.deepEqual(corrected, ['openai-completions', '上下文 4K', '输出 1K', '输入 text'])
})

test('the model-source line names where the numbers come from, and the fallback', () => {
  const line = modelSourceLine()
  assert.match(line, /网关 \/models/u)
  // 0.9.0: the declared numbers are read from models.dev AT RUNTIME, so the page
  // names that source — and names what happens when the read fails, because
  // "the numbers are still there" is the promise the bundled copy makes.
  assert.match(line, /models\.dev/u)
  assert.match(line, /运行期同步/u)
  assert.match(line, /回退到插件内置数据/u)
  assert.match(line, /保守默认/u)
})

test('the picker reads refreshError off the catalogue payload', () => {
  const view = catalogueView({ ok: true, models: [], refreshError: 'GET https://x/v1/models answered HTTP 503' })
  assert.equal(view.refreshError, 'GET https://x/v1/models answered HTTP 503')
  assert.equal(catalogueView({ ok: true, models: [] }).refreshError, undefined)
})

// ── the immediate-commit path ──────────────────────────────────────────────

test('modelsWriteOps writes ONLY the models paths (a pick never smuggles scalars)', () => {
  const clean = formFromView(viewOf({ user: { baseURL: 'https://a/v1', models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: false } } }))
  const draft = { ...clean, baseURL: 'https://half-typed/v1', disabled: ['b'] }
  const ops = modelsWriteOps(clean, draft)
  assert.deepEqual(ops.map((op) => op.path.join('.')), [
    'models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered',
  ])
  assert.deepEqual(modelsWriteOps(clean, { ...clean, baseURL: 'https://other/v1' }), [], 'scalar-only change owes no model write')
})

test('preserveDraftScalars keeps the unsaved typing across a models commit', () => {
  const saved = formFromView(viewOf({ user: { baseURL: 'https://a/v1', models: { disabled: ['b'], extra: [], overrides: {}, replaceDiscovered: false } } }))
  // The staged key is a ROW field now: it rides the `subscriptions` slice, so
  // dropping the old top-level `apiKey` must not lose it.
  const typed = {
    ...saved,
    baseURL: 'https://typing/v1',
    sessionHeader: 'x-new',
    subscriptions: patchSubRow(saved, 'default', { apiKey: STAGED }).subscriptions,
  }
  const merged = preserveDraftScalars(saved, typed)
  assert.equal(merged.baseURL, 'https://typing/v1')
  assert.equal(merged.sessionHeader, 'x-new')
  assert.equal(merged.subscriptions[0].apiKey, STAGED)
  // The models block comes from the server, not the pre-commit draft.
  assert.deepEqual(merged.disabled, ['b'])
})

test('the credential copy says where the value goes', async () => {
  // The key field carries no hint line any more (the promise moved to the slot
  // tooltip and the credential pill); what stays pinned is the migration
  // warning and the session-header grammar.
  const { SESSION_HEADER_HINT, LEGACY_API_KEY_WARNING } = await import('../src/client/vocab.js')
  assert.match(LEGACY_API_KEY_WARNING, /迁移/u)
  assert.match(SESSION_HEADER_HINT, /RFC 7230/u)
})

// ── helpers the rest of this file relies on stay honest ─────────────────────

test('deepEqual is structural, not referential', () => {
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true)
  assert.equal(deepEqual({ a: 1, b: undefined }, { a: 1 }), true)
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
})


// ── capability sync ─────────────────────────────────────────────────────────

test('syncTargetIds visits each ENABLED model once, in page order', () => {
  assert.deepEqual(
    syncTargetIds([{ id: 'alpha' }, { id: 'beta' }, { id: 'alpha' }, { id: '' }, {}]),
    ['alpha', 'beta'],
    'the sync is scoped to what is enabled, deduplicated',
  )
  assert.deepEqual(syncTargetIds(undefined), [])
})

test('describeSync turns a measured result into one line an operator can act on', () => {
  const ok = describeSync({
    available: true,
    status: 'available',
    protocol: { chosen: 'openai-completions', verified: true },
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ['text', 'image'],
    reasoning: { levels: { low: 'low', high: 'high' }, hasOff: true },
  })
  assert.equal(ok.tone, 'ok')
  assert.match(ok.detail, /协议 openai-completions/u)
  assert.match(ok.detail, /上下文 1\.0M/u)
  assert.match(ok.detail, /输出 131K/u)
  assert.match(ok.detail, /输入 text\+image/u)
  assert.match(ok.detail, /思考 off\/low\/high/u)
  assert.equal(ok.replace, false)

  // A dead model must be LOUD and must point somewhere else.
  const dead = describeSync({ available: false, status: 'delisted', reason: '上游已下架：Model is unavailable.' })
  assert.equal(dead.tone, 'bad')
  assert.match(dead.headline, /已下架/u)
  assert.equal(dead.replace, true)

  const gated = describeSync({ available: false, status: 'gated', reason: '区域门控' })
  assert.equal(gated.tone, 'warn')
  assert.match(gated.headline, /门控/u)

  // A recommendation that did not answer is stated, not hidden.
  const fallback = describeSync({
    available: true, status: 'available',
    protocol: { chosen: 'anthropic-messages', verified: false },
    reasoning: { levels: {}, hasOff: false },
  })
  assert.match(fallback.detail, /非推荐/u)

  // A refused official contract is explained rather than silently narrowed.
  const narrowed = describeSync({
    available: true, status: 'available', protocol: { chosen: 'openai-completions', verified: true },
    reasoning: { levels: { low: 'low' }, hasOff: true, declaredContractWorks: false },
  })
  assert.match(narrowed.note, /官方契约/u)
  assert.equal(describeSync(undefined), undefined)
})

test('syncProgressText separates what FINISHED from what is in flight', () => {
  assert.equal(syncProgressText({ busy: false }), undefined)
  // The first version printed `done + 1` as the headline, so it sat on the same
  // number for the whole of a slow model and read as frozen.
  const mid = syncProgressText({ busy: true, done: 1, total: 8, current: 'glm-5.3', startedAt: 1000 }, 13_000)
  assert.match(mid, /已完成 1\/8/u)
  assert.match(mid, /正在处理 glm-5.3/u)
  assert.match(mid, /已用 12s/u)
  // The count moves as models complete, even while one is in flight.
  const later = syncProgressText({ busy: true, done: 5, total: 8, current: 'glm-5.3', startedAt: 1000 }, 13_000)
  assert.match(later, /已完成 5\/8/u)
  assert.match(later, /已用 12s/u)
  // With nothing in flight the model name is simply absent, not stale.
  assert.equal(syncProgressText({ busy: true, done: 3, total: 3, startedAt: 0 }, 0), '已完成 3/3 · 已用 0s')
})

test('replacementSuggestions offers a WORKING model, never a dead one', () => {
  const rows = [{ id: 'dead' }, { id: 'alsoDead' }, { id: 'alive' }]
  const suggestions = replacementSuggestions(rows, {
    dead: { available: false, status: 'delisted' },
    alsoDead: { available: false, status: 'gated' },
    alive: { available: true },
  })
  assert.deepEqual(suggestions, { dead: 'alive', alsoDead: 'alive' })
  // With nothing working there is nothing honest to suggest.
  assert.deepEqual(replacementSuggestions(rows, { dead: { available: false } }), {})
  // A model that works is never given a replacement.
  assert.deepEqual(replacementSuggestions(rows, { alive: { available: true } }), {})
})

test('with the shipped default, nothing is enabled until the picker says so', () => {
  // Replacement mode is the SHIPPED default: a fresh install must load NO
  // models, and the picker must still be able to activate them.
  const form = formFromView({ namespaces: [{ namespace: 'opencode-go-native', revision: 'r1', document: {} }] })
  assert.equal(form.replaceDiscovered, true, 'the default loads nothing')
  assert.deepEqual(effectiveIds(form, ['alpha', 'beta']), [], 'advertised models are not auto-enabled')

  const picked = setModelSelection(form, [{ id: 'alpha' }, { id: 'beta' }], ['beta'])
  // The selection lands in `extra`, because in this mode that IS the enabled set.
  assert.deepEqual(picked.extra.map((row) => row.id), ['beta'])
  assert.deepEqual(effectiveIds(picked, ['alpha', 'beta']), ['beta'], 'only the picked model loads')

  // De-selecting removes it again.
  const empty = setModelSelection(picked, [{ id: 'alpha' }, { id: 'beta' }], [])
  assert.deepEqual(effectiveIds(empty, ['alpha', 'beta']), [])

  // A hand-added model the picker never listed is not the picker's to drop.
  const withHandAdded = { ...picked, extra: [...picked.extra, { id: 'hand-added', name: 'Hand' }] }
  const after = setModelSelection(withHandAdded, [{ id: 'alpha' }, { id: 'beta' }], [])
  assert.deepEqual(effectiveIds(after, ['alpha', 'beta']), ['hand-added'])
})

/* ── subscriptions + balance (0.8.2) ───────────────────────────────────── */

const baseView = (user = {}) => ({
  ns: 'opencode-go-native',
  value: {
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    models: {},
  },
  user,
  revision: 3,
  secrets: [],
})

test('an untouched pre-0.8 document round-trips to NO subscriptions write at all', () => {
  const form = formFromView(baseView())
  assert.equal(form.subscriptions.length, 1, 'the default row always exists')
  assert.equal(form.subscriptions[0].isDefault, true)
  // The default row owns a derived slot like every other row; the LIVE slot
  // (`apiKeyEnv`) is what the host writes the active key into, not a row's slot.
  assert.equal(subscriptionSlotOf(form.subscriptions[0]), 'OPENCODE_GO_DEFAULT')
  assert.equal(form.activeSubscription, 'default', 'exactly one row pays, and it starts as default')
  assert.deepEqual(subsBlockFrom(form), [], 'the default row is never stored in the array')
  assert.deepEqual(writeOps(form, form), [])
})

test('a stored extra entry loads into an editable row and writes back equal', () => {
  // The stored shape is a NAME and (optionally) an id: nothing else.
  const user = { subscriptions: [{ id: 'work', label: '公司号' }] }
  const form = formFromView(baseView(user))
  assert.deepEqual(form.subscriptions.map((row) => row.key), ['default', 'work'])
  const work = form.subscriptions[1]
  assert.equal(work.label, '公司号')
  assert.equal(work.apiKey, '', 'the row stages a NEW key, never a stored one')
  assert.deepEqual(subsBlockFrom(form), [{ id: 'work', label: '公司号' }])
  // Re-serializing is byte-stable: a save with no edit emits no ops.
  assert.deepEqual(writeOps(form, form), [])
})

test('the default row is NEVER written into the subscriptions array', () => {
  const form = formFromView(baseView())
  assert.deepEqual(subsBlockFrom(form), [])
  // Renaming the default row is a TOP-LEVEL write (`displayName`), never a
  // `{ id: 'default' }` entry. Its credential slot is DERIVED and cannot be
  // renamed at all any more: it is not a field of the row.
  const renamed = patchSubRow(form, 'default', { label: '主号' })
  assert.deepEqual(subsBlockFrom(renamed), [], 'still nothing stored in the array')
  assert.equal(subscriptionSlots(form).get('default'), 'OPENCODE_GO_DEFAULT')

  const draft = { ...form, displayName: '主号', apiKeyEnv: 'MY_SLOT' }
  assert.deepEqual(writeOps(form, draft), [
    { op: 'set', path: ['apiKeyEnv'], value: 'MY_SLOT' },
    { op: 'set', path: ['displayName'], value: '主号' },
  ])
})
test('mintSubscriptionId hands out the first unused sub-N id', () => {
  assert.equal(mintSubscriptionId(), 'sub-2')
  assert.equal(mintSubscriptionId(new Set(['default'])), 'sub-2')
  assert.equal(mintSubscriptionId(new Set(['default', 'sub-2'])), 'sub-3')
  assert.equal(mintSubscriptionId(new Set(['sub-2', 'sub-3', 'sub-5'])), 'sub-4')
  // Ids are opaque on purpose: they are addresses, not names, so a rename can
  // never move one (and with it the credential slot).
  assert.match(mintSubscriptionId(), /^[A-Za-z0-9_-]{1,40}$/u)
})

test('subscriptionSlotOf names the slot after the row, and never uses the LIVE slot', () => {
  // A NAME that slugs to nothing (Chinese, punctuation) falls back to the
  // id-derived spelling, which is also what the host resolves for it.
  assert.equal(subscriptionSlotOf({ isDefault: true }, '默认'), 'OPENCODE_GO_DEFAULT')
  assert.equal(subscriptionSlotOf({ id: 'default' }), 'OPENCODE_GO_DEFAULT')
  assert.equal(subscriptionSlotOf({ id: 'work' }), 'OPENCODE_GO_WORK')
  assert.equal(subscriptionSlotOf({ id: 'a-b.c' }), 'OPENCODE_GO_A_B_C')
  assert.equal(subscriptionSlotOf({ id: 'sub-2', label: 'me@example.com' }), 'OPENCODE_GO_ME_EXAMPLE_COM')
})

test('add/append, remove, and blank-row dropping behave like the extra rows', () => {
  let form = formFromView(baseView())
  form = addSubscriptionRow(form)
  assert.equal(form.subscriptions.length, 2)
  // The id EXISTS from birth: it is not minted on save, because a key that moves
  // under the draft breaks the expanded panel, the staged secret's address, and
  // the dirty comparison all at once.
  assert.equal(form.subscriptions[1].id, 'sub-2')
  assert.equal(form.subscriptions[1].key, 'sub-2', 'the row key IS its id, so it never moves')
  assert.deepEqual(subsBlockFrom(form), [], 'a blank adder row is not a write')

  form = patchSubRow(form, form.subscriptions[1].key, { label: 'Home' })
  assert.deepEqual(subsBlockFrom(form), [{ id: 'sub-2', label: 'Home' }])
  assert.deepEqual([...subscriptionSlots(form).values()], ['OPENCODE_GO_DEFAULT', 'OPENCODE_GO_HOME'])
  // A rename keeps the id where it was (that is the row's stable address) while
  // the credential SLOT follows the name — the runtime keeps the id-derived
  // spelling as the fallback and moves the stored key across.
  form = patchSubRow(form, 'sub-2', { label: '家' })
  assert.deepEqual(subsBlockFrom(form), [{ id: 'sub-2', label: '家' }])
  assert.equal(subscriptionSlots(form).get('sub-2'), 'OPENCODE_GO_SUB_2', 'no slug in that name')

  // Removal addresses a row by its stable KEY.
  form = removeSubRow(form, 'sub-2')
  assert.deepEqual(subsBlockFrom(form), [])
  // The default row has no entry to delete (the host synthesizes it), so
  // "deleting" it HIDES it — and the marker is what reaches the document.
  const hidden = removeSubRow(form, 'default')
  assert.equal(hidden.subscriptions[0].isDefault, true)
  assert.equal(defaultRowHidden(hidden), true)
  assert.deepEqual(subsBlockFrom(hidden), [{ id: 'default', hidden: true }])
  // The way back is one call, so the click is not a one-way door.
  assert.equal(defaultRowHidden(restoreDefaultRow(hidden)), false)
  assert.deepEqual(subsBlockFrom(restoreDefaultRow(hidden)), [])
})

test('a document row whose id was lost gets a deterministic stand-in, never a duplicate', () => {
  // The host refuses an entry with no id, so this is a broken document — the
  // page must not turn it into two rows claiming one id.
  const form = formFromView(baseView({ subscriptions: [{ label: 'lost' }, { label: 'kept', id: 'sub-2' }] }))
  const block = subsBlockFrom(form)
  assert.equal(new Set(block.map((entry) => entry.id)).size, block.length, 'ids stay unique')
  assert.deepEqual(block.map((entry) => entry.label), ['lost', 'kept'])
})

test('hiding a row takes it off the list and leaves an unrelated pointer alone', () => {
  const form = formFromView(baseView({ subscriptions: [{ id: 'work', label: '公司号' }] }))
  const hidden = removeSubRow(activateSubscription(form, 'work'), 'default')
  assert.equal(defaultRowHidden(hidden), true)
  assert.equal(hidden.activeSubscription, 'work', 'the pointer named a visible row, so it stands')
  assert.deepEqual(subsBlockFrom(hidden), [
    { id: 'default', hidden: true },
    { id: 'work', label: '公司号' },
  ])
  // A pointer naming a HIDDEN row is refused: the host would resolve it back to
  // the first visible row, which is not what the click meant.
  assert.match(validateForm({ ...hidden, activeSubscription: 'default' }).activeSubscription, /不在列表里/u)
  // Restoring puts it back with no other effect.
  assert.deepEqual(subsBlockFrom(restoreDefaultRow(hidden)), [{ id: 'work', label: '公司号' }])
})

test('deleting the row that PAYS repoints the pointer, and the last row cannot be hidden', () => {
  const form = formFromView(baseView({ subscriptions: [{ id: 'work', label: '公司号' }] }))
  // The page disables the trash on the active row, so this is the defensive
  // path: a hand-built draft must still not leave the route billing a row that
  // is gone.
  const repointed = removeSubRow(form, 'default')
  assert.equal(repointed.activeSubscription, 'work', 'the next visible row takes over')
  // Hiding the LAST visible row is refused before anything is written.
  const noneLeft = removeSubRow({ ...form, subscriptions: [form.subscriptions[0]] }, 'default')
  assert.match(validateForm(noneLeft).subscriptions, /至少要保留一条订阅/u)
})

test('only one subscription is active, and activating commits the pointer (and the list when it moved)', () => {
  const clean = formFromView(baseView({ subscriptions: [{ id: 'work', label: '公司号' }] }))
  assert.equal(clean.activeSubscription, 'default')

  const switched = activateSubscription(clean, 'work')
  assert.equal(switched.activeSubscription, 'work', 'a click moves the single pointer; there is no second boolean')
  assert.deepEqual(writeOps(clean, switched), [
    { op: 'set', path: ['activeSubscription'], value: 'work' },
  ])
  // The stored list already holds the row, so the click writes only the pointer.
  assert.deepEqual(activationWriteOps(clean, switched, 'work'), [
    { op: 'set', path: ['activeSubscription'], value: 'work' },
  ])
  // Clicking the row that already pays is a no-op.
  assert.deepEqual(activationWriteOps(switched, switched, 'work'), [])
  // Clicking the DEFAULT row writes the pointer back — the row has no stored
  // ENTRY (the host synthesizes it), which is exactly why a targeted writer that
  // only walked the stored entries used to answer "no ops" and leave the page
  // claiming a switch the host never received.
  const back = activateSubscription(switched, 'default')
  assert.equal(back.activeSubscription, 'default')
  assert.deepEqual(activationWriteOps(switched, back, 'default'), [
    { op: 'set', path: ['activeSubscription'], value: 'default' },
  ])
  assert.deepEqual(activationWriteOps(back, back, 'default'), [], 'and the settled state is quiet')
  // A hidden row cannot be activated at all.
  const hidden = removeSubRow({ ...switched, activeSubscription: 'work' }, 'default')
  assert.deepEqual(activationWriteOps(switched, hidden, 'default'), [])
  // An unknown row key changes nothing.
  assert.equal(activateSubscription(clean, 'ghost'), clean)

  // A row that has never been SAVED still has its id (it was minted at birth),
  // so the click commits the LIST as well — the host has never seen that id.
  const added = addSubscriptionRow(clean)
  const named = patchSubRow(added, added.subscriptions[2].key, { label: 'Home' })
  const next = activateSubscription(named, named.subscriptions[2].key)
  assert.deepEqual(activationWriteOps(clean, next, named.subscriptions[2].key), [
    { op: 'set', path: ['subscriptions'], value: [{ id: 'work', label: '公司号' }, { id: 'sub-2', label: 'Home' }] },
    { op: 'set', path: ['activeSubscription'], value: 'sub-2' },
  ])
  // Once that write lands, the same click is a no-op — the key the draft holds
  // is the id the document holds, so nothing looks dirty any more.
  assert.deepEqual(activationWriteOps(next, next, 'sub-2'), [])
})

test('writeOps emits the whole-array set ONLY when the block moved', () => {
  const form = formFromView(baseView())
  const added = addSubscriptionRow(form)
  const named = patchSubRow(added, added.subscriptions[1].key, { label: 'Home' })
  const ops = writeOps(form, named)
  const sub = ops.filter((op) => op.path[0] === 'subscriptions')
  assert.equal(sub.length, 1)
  assert.deepEqual(sub[0].value, [{ id: 'sub-2', label: 'Home' }])
  assert.deepEqual(writeOps(form, form).filter((op) => op.path[0] === 'subscriptions'), [])
})

test('validators refuse a nameless row, duplicate names, a bad id/slot, and an unusable key', () => {
  const base = {
    baseURL: 'https://x/v1', apiKeyEnv: 'K', sessionHeader: 'x-s', sessionHeaderEnabled: false,
    sessionHeaderMode: 'session-id', disabled: [], extra: [], overrides: [], replaceDiscovered: false,
    activeSubscription: 'default',
  }
  const defaultRow = { key: 'default', isDefault: true, id: 'default', label: '', apiKeyRef: 'OPENCODE_GO_API_KEY', apiKey: '' }
  const validate = (rows) => validateForm({ ...base, subscriptions: [defaultRow, ...rows] })
  const extra = (over) => ({ key: 'a', isDefault: false, id: '', label: '', apiKeyRef: '', apiKey: '', ...over })

  // The id and slot derive from the NAME, so a row that claims anything (a key,
  // a name) without one is refused on its name cell.
  const nameless = validate([extra({ apiKey: 'sk-1' })])
  assert.match(nameless['subscriptions[1].label'], /必填/u)
  // Two rows may not share a name — the duplicate id that would follow is the
  // exact document shape the host refuses to resolve.
  const dup = validate([
    extra({ key: 'a', id: 'work', label: '公司号' }),
    extra({ key: 'b', id: 'work2', label: '公司号' }),
  ])
  assert.match(dup['subscriptions[2].label'], /重名/u)
  // A stored id the host's own pattern would reject is surfaced on the row.
  const badId = validate([extra({ id: 'bad id!', label: 'ok' })])
  assert.match(badId['subscriptions[1].label'], /内部 id 不合法/u)
  // There is no per-row credential slot to validate any more: the only slot a
  // row can name is its derived one, and `subsBlockFrom` never writes one.
  const slotted = extra({ id: 'okid', label: 'ok', apiKeyRef: '9bad' })
  assert.deepEqual(subsBlockFrom({ subscriptions: [defaultRow, slotted] }), [{ id: 'okid', label: 'ok' }])
  // A pasted key on ANY row (the default row included) must be header-carryable.
  const badKey = validateForm({ ...base, subscriptions: [{ ...defaultRow, apiKey: 'sk-a\nb' }] })
  assert.match(badKey['subscriptions[0].apiKey'], /控制字符|换行/u)
  // An active pointer naming no row is refused, not silently reset.
  const ghost = validateForm({ ...base, subscriptions: [defaultRow], activeSubscription: 'ghost' })
  assert.match(ghost.activeSubscription, /不在列表里/u)
})

test('staged credentials are labelled per row, and every row owns its derived slot', () => {
  const form = formFromView(baseView({
    displayName: '主号',
    apiKeyEnv: 'MY_KEY',
    subscriptions: [{ id: 'work', label: '公司号' }],
  }))
  const staged = patchSubRow(
    patchSubRow(form, 'default', { apiKey: 'sk-default-0123456789' }),
    'work',
    { apiKey: 'sk-work-0123456789' },
  )
  // `apiKeyEnv: MY_KEY` is the LIVE slot, not the default row's storage: the
  // rows keep their own derived slots, so renaming the live variable can never
  // move a stored key.
  assert.deepEqual(stagedCredentialPlans(staged), [
    { reference: 'OPENCODE_GO_DEFAULT', value: 'sk-default-0123456789', label: '主号', key: 'default' },
    { reference: 'OPENCODE_GO_WORK', value: 'sk-work-0123456789', label: '公司号', key: 'work' },
  ])
})

test('usageView whitelists the new row shape, and balanceCells reads each known window', () => {
  const now = Date.UTC(2026, 8, 19)
  const view = usageView({
    ok: true,
    subs: [{
      id: 'work', label: 'work', apiKeyRef: 'W', isDefault: false, active: true, configured: true, source: 'store',
      // The legacy spellings the row's key may still live under — the page clears
      // them all, so the whitelist has to carry them.
      fallbackRefs: ['OPENCODE_GO_SUB_2', '', 7],
      // Fields the redesign removed: the whitelist must not let them through.
      state: 'capped', detail: '周 92%', cap: { weekly: 90 }, enabled: true, baseURL: 'https://x/v1',
      usage: { windows: { weekly: { status: 'ok', percent: 92, resetsAt: 'nope' } }, checkedAt: now, ageMs: 5, error: 'boom' },
    }],
  })
  assert.equal(view.subs.length, 1)
  const row = view.subs[0]
  assert.equal(row.apiKeyRef, 'W')
  assert.equal(row.active, true)
  assert.equal(row.configured, true)
  assert.equal(row.source, 'store')
  assert.deepEqual(row.fallbackRefs, ['OPENCODE_GO_SUB_2'], 'the legacy spellings survive the whitelist, filtered to strings')
  for (const gone of ['state', 'detail', 'cap', 'enabled', 'baseURL']) {
    assert.equal(gone in row, false, `${gone} is not part of the new row shape`)
  }
  assert.equal(row.usage.checkedAt, now)
  assert.equal(row.usage.ageMs, 5)
  assert.equal(row.usage.error, 'boom')

  assert.deepEqual(balanceCells(row), [
    { window: 'weekly', label: '周', percent: 92, status: 'ok', resetsAt: 'nope', tone: 'warn' },
  ])
  // Tone rules: a non-`ok` status is bad, a missing percent is dim, >= 85 warns.
  assert.equal(balanceCells({ usage: { windows: { rolling: { status: 'exhausted' } } } })[0].tone, 'bad')
  assert.equal(balanceCells({ usage: { windows: { monthly: { status: 'ok' } } } })[0].tone, 'dim')
  assert.equal(balanceCells({ usage: { windows: { weekly: { status: 'ok', percent: 83 } } } })[0].tone, 'ok')
  assert.equal(balanceCells({ usage: { windows: { weekly: { status: 'ok', percent: 85 } } } })[0].tone, 'warn')
  // Only KNOWN windows produce a cell; nothing measured means no bars at all.
  assert.deepEqual(balanceCells({ usage: { windows: { hourly: { status: 'ok', percent: 10 } } } }), [])
  assert.deepEqual(balanceCells({}), [])
  assert.equal(resetPhrase(new Date(now + 90 * 60_000).toISOString(), now), '约 2 小时后重置')
  assert.equal(resetPhrase('garbage', now), undefined)
  // The line UNDER a pill says the same moment with fewer words — one parse, so
  // the two can never disagree about when; only about how much room they have.
  assert.equal(resetShort(new Date(now + 90 * 60_000).toISOString(), now), '2 小时后')
  assert.equal(resetShort(new Date(now + 25 * 60_000).toISOString(), now), '25 分钟后')
  assert.equal(resetShort(new Date(now + 50 * 3600_000).toISOString(), now), '2 天后')
  // A moment already gone reads "due now", never a negative number.
  assert.equal(resetShort(new Date(now - 5 * 60_000).toISOString(), now), '即将重置')
  assert.equal(resetShort(undefined, now), undefined)
  assert.equal(resetShort('garbage', now), undefined)
  // The tooltip's stamp is the local wall clock, not the ISO blob.
  const stampIso = new Date(now + 90 * 60_000).toISOString()
  const stampAt = new Date(stampIso)
  const pad = (value) => String(value).padStart(2, '0')
  assert.equal(
    resetStamp(stampIso),
    `${pad(stampAt.getMonth() + 1)}-${pad(stampAt.getDate())} ${pad(stampAt.getHours())}:${pad(stampAt.getMinutes())}`,
  )
  assert.equal(resetStamp('garbage'), undefined)
  assert.equal(resetStamp(undefined), undefined)
})

test('the page derives the SAME credential slot the host resolves', () => {
  // The slot is named after the subscription, so the page and the host must
  // agree on the slug AND on the id-derived fallback an unnamed row uses.
  for (const [label, expected] of [
    ['me@example.com', 'OPENCODE_GO_ME_EXAMPLE_COM'],
    ['work@example.com', 'OPENCODE_GO_WORK_EXAMPLE_COM'],
    ['Work号', 'OPENCODE_GO_WORK'],
    ['a-b.c', 'OPENCODE_GO_A_B_C'],
  ]) {
    assert.equal(subscriptionSlotOf({ id: 'work', label }), expected)
    assert.equal(refForSubscriptionLabel(label), expected, 'the host derives the same name')
  }
  // A row with no usable name falls back to the stable id-derived spelling.
  assert.equal(subscriptionSlotOf({ id: 'sub-2', label: '' }), 'OPENCODE_GO_SUB_2')
  assert.equal(subscriptionSlotOf({ id: DEFAULT_SUB_ID, isDefault: true }, '默认'), 'OPENCODE_GO_DEFAULT')
  assert.equal(refForSubscriptionLabel('默认'), undefined, 'a name with no A-Z0-9 has no slug')
})

test('a rename MOVES the slot, and the id-derived spelling stays as the fallback', () => {
  // Slots follow the name now. The id-derived spelling is what the runtime keeps
  // as a fallback (and what `migrateSlots` copies FROM), so a rename does not
  // lose the key — but the slot the page shows must move with the name.
  assert.equal(subscriptionSlotOf({ id: 'sub-2', label: '公司号' }), 'OPENCODE_GO_SUB_2', 'no slug in that name')
  assert.equal(subscriptionSlotOf({ id: 'sub-2', label: 'Work号' }), 'OPENCODE_GO_WORK')
  const [row] = normalizeSubscriptions([{ id: 'sub-2', label: 'Work号' }], { apiKeyEnv: 'MAIN' }).slice(1)
  assert.equal(row.apiKeyRef, 'OPENCODE_GO_WORK')
  assert.deepEqual(row.fallbackRefs, ['OPENCODE_GO_SUB_2'])
})

test('usageView ignores the live-slot block the page no longer shows', () => {
  // The host still reports it (diagnostics); the page deliberately does not read
  // it, and `subs` remains a strict whitelist of the row shape.
  const view = usageView({
    ok: true,
    live: { liveRef: 'OPENCODE_GO_API_KEY', value: 'sk-SECRET-not-real' },
    subs: [{ id: 'work', label: '公司号', apiKeyRef: 'W', active: true }],
  })
  assert.equal('live' in view, false)
  assert.equal(view.subs.length, 1)
  assert.equal(view.subs[0].apiKeyRef, 'W')
})

test('host rejections on subscription paths land on the subscriptions field', () => {
  assert.ok(errorPathsOf('opencode-go-native: subscriptions[1].id is not a valid subscription id').includes('subscriptions[1]'))
  assert.ok(errorPathsOf('opencode-go-native: subscriptions["work"].label is longer than 60 characters').includes('subscriptions[work]'))
  assert.ok(errorPathsOf('subscriptions must be an array').includes('subscriptions'))
})

test('preserveDraftScalars keeps subscription typing across a models-only commit', () => {
  const saved = formFromView(baseView())
  const added = addSubscriptionRow(saved)
  const draft = patchSubRow(added, added.subscriptions[1].key, { label: 'typing' })
  const merged = preserveDraftScalars(saved, draft)
  assert.equal(merged.subscriptions.length, 2, 'the half-typed row survives the commit')
  assert.equal(merged.subscriptions[1].label, 'typing')
})
