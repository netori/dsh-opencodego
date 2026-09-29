/**
 * The volatile contract between this plugin's CONFIG SCHEMA and its settings
 * page (dsh 0.1.7).
 *
 * dsh 0.1.7 replaced the imperative `settings.installSection(...)` section with
 * a schema-derived one: the descriptor a settings page reads carries the
 * VOLATILE fields of the entry's Config and nothing else, and a write is refused
 * for any path that is not volatile (`Config field "x" is not volatile`,
 * `@deepseek-ai/dsh-settings#write`). Both halves of a missing mark fail
 * SILENTLY where no runtime test can see them:
 *
 *   - a field that is not volatile READS back absent, so the page renders its
 *     own default and then acts on a value the host never had;
 *   - a field that is not volatile cannot be WRITTEN, so every save the page
 *     makes is refused.
 *
 * So the marks ARE the page's interface. This test holds both directions of it:
 * what the page reads (`formFromView`) is exactly what is volatile, and what the
 * page writes (`writeOps` / `modelsWriteOps` / `activationWriteOps`) is volatile
 * too.
 *
 * The host's rule is five lines long and lives inside a class the host does not
 * export (`isVolatilePath`), so it is replicated here; this test is the only
 * place that would notice the two drifting apart.
 *
 * @module tests/volatile-contract
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

import {
  activationWriteOps,
  addSubscriptionRow,
  formFromView,
  modelsWriteOps,
  patchSubRow,
  writeOps,
} from '../src/client/logic.js'
import { Config, createOptionsReader, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, resolveOptions } from '../src/config.js'

/**
 * The host's rule: a path is writable when it or any ancestor is volatile.
 *
 * Replicated from `@deepseek-ai/dsh-settings` (`isVolatilePath`); the import is
 * a host module the tests deliberately do not load (see `tests/vocabulary`).
 *
 * @param {object} schema - a schemastery schema node.
 * @param {readonly string[]} path - the field path being written.
 * @returns {boolean} whether a write to that path is accepted.
 */
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/** The fields `src/config.js` marks volatile: the settings page's whole surface. */
const VOLATILE_FIELDS = [
  'activeSubscription',
  'apiKeyEnv',
  'baseURL',
  'displayName',
  'models',
  'sessionHeader',
  'sessionHeaderEnabled',
  'sessionHeaderMode',
  'subscriptions',
  'sync',
]

/** The form keys that are stored INSIDE the `models` block rather than beside it. */
const MODEL_FORM_KEYS = new Set(['disabled', 'extra', 'overrides', 'replaceDiscovered'])

test('the page\'s read surface is exactly the volatile surface', () => {
  const readPaths = new Set(Object.keys(formFromView({}))
    .map((key) => (MODEL_FORM_KEYS.has(key) ? 'models' : key)))
  assert.deepEqual([...readPaths].sort(), VOLATILE_FIELDS,
    'a field the page reads but the schema does not mark volatile reads back absent — mark it, or stop reading it')
})

test('no other Config field is volatile, and no secret ever is', () => {
  const marked = Object.entries(Config.dict)
    .filter(([, schema]) => schema.meta.volatile === true)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(marked, VOLATILE_FIELDS, 'the volatile set is the page contract, not a free-for-all')
  assert.equal(isVolatilePath(Config, ['apiKey']), false,
    'apiKey is redacted from every wire read; it must never be a form field')
})

test('every path the page writes is volatile', () => {
  const clean = formFromView({ value: {}, user: {} })

  // Every scalar `writeOps` knows about, moved at once. The exact path list is
  // the assertion: a key silently dropped from the page's list would leave the
  // field un-writable from the UI, which no runtime error reports.
  const scalarDraft = {
    ...clean,
    baseURL: 'https://edited.example/v1',
    apiKeyEnv: 'EDITED_REF',
    displayName: 'edited',
    sessionHeader: 'x-edited',
    sessionHeaderEnabled: !clean.sessionHeaderEnabled,
    sessionHeaderMode: clean.sessionHeaderMode === 'session-id' ? 'uuid' : 'session-id',
    sync: !clean.sync,
    activeSubscription: 'other',
  }
  assert.deepEqual(
    writeOps(clean, scalarDraft).map((op) => op.path.join('.')).sort(),
    ['activeSubscription', 'apiKeyEnv', 'baseURL', 'displayName', 'sessionHeader',
      'sessionHeaderEnabled', 'sessionHeaderMode', 'sync'],
  )

  const modelsDraft = { ...clean, disabled: ['some-model'], replaceDiscovered: false }
  const modelPaths = modelsWriteOps(clean, modelsDraft).map((op) => op.path.join('.'))
  assert.deepEqual(modelPaths.sort(),
    ['models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered'])

  const withRow = addSubscriptionRow(clean)
  const rowKey = withRow.subscriptions[withRow.subscriptions.length - 1].key
  // A row only has an id to point at once it has a NAME (the id is minted from
  // it), which is also when activating it owes the host the whole list.
  const named = patchSubRow(withRow, rowKey, { label: 'Home' })
  const activationPaths = activationWriteOps(clean, named, rowKey).map((op) => op.path.join('.'))
  assert.ok(activationPaths.includes('subscriptions'), 'adding a row is a subscriptions write')

  const written = [
    ...writeOps(clean, scalarDraft).map((op) => op.path),
    ...modelsWriteOps(clean, modelsDraft).map((op) => op.path),
    ...activationWriteOps(clean, named, rowKey).map((op) => op.path),
  ]
  for (const path of written) {
    assert.ok(isVolatilePath(Config, path), `write path "${path.join('.')}" is not volatile`)
  }
})

test('the entry still has a form at all', () => {
  // `describe()` SKIPS an entry whose schema has no volatile field, so a plugin
  // with none disappears from the settings service entirely.
  const hasVolatileField = (schema) => schema.meta.volatile === true
    || (schema.type === 'object' && Object.values(schema.dict ?? {}).some(hasVolatileField))
  assert.ok(hasVolatileField(Config))
})

test('the resolver reads the shape the host validates into', () => {
  // Once the entry carries a schema, the loader validates its config against it
  // (`runtime.Config["~standard"].validate(config)`, cordis `resolveConfig`) and
  // every volatile field arrives as a cosmokit REFERENCE. Reading it directly
  // is how the first settings-port build died:
  // `baseURL must be an absolute http(s) URL (got: [object Object])`.
  const validated = Config['~standard'].validate({}).value
  assert.notEqual(typeof validated.baseURL, 'string',
    'the volatile field is a reference, not a value — the resolver must unwrap it')
  assert.equal(typeof validated.baseURL.get(), 'string')

  const facts = resolveOptions(validated)
  assert.equal(facts.baseURL, DEFAULT_BASE_URL)
  assert.equal(facts.apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.equal(facts.sync, false)
  assert.deepEqual(facts.models.disabled, [], 'the volatile `models` block resolves too')
  // Plain config keeps working: this is the same entry point the tests,
  // the migration, and a hand-built composition use.
  assert.equal(resolveOptions({}).baseURL, DEFAULT_BASE_URL)
  assert.equal(resolveOptions({ baseURL: 'https://example.test/v1' }).baseURL, 'https://example.test/v1')
})

test('a settings write reaches the host half WITHOUT the entry being re-applied', () => {
  // dsh 0.2.0 does not re-apply an entry for a write whose differences are all
  // schema-volatile fields: `Entry#update` classifies it
  // (`equalExceptVolatile`), calls `_commitVolatile()`, and commits the new
  // values INTO the references of the config object `apply` was handed. The
  // object's identity survives the write; only the values behind its references
  // move. A reader that memoized on that identity therefore answers with the
  // load-time snapshot forever — which is exactly how this plugin lost a newly
  // added subscription (invisible to the host: no balance row, no probe, the
  // wrong payer), and every model-set change with it.
  const live = Config['~standard'].validate({}).value
  const read = createOptionsReader(() => live)

  const before = read()
  assert.deepEqual(before.subscriptions.map((sub) => sub.id), ['default'],
    'a fresh document has the implicit default row only')
  assert.equal(read(), before, 'unchanged facts keep the resolved object the adapter keys its state on')

  // The write a settings page makes: three volatile paths, in place.
  updateVolatile(live.displayName, createVolatile('whoiszzj@outlook.com'))
  updateVolatile(live.activeSubscription, createVolatile('sub-2'))
  updateVolatile(live.subscriptions, createVolatile([{ id: 'sub-2', label: 'withzzj@gmail.com' }]))
  updateVolatile(live.models, createVolatile({ disabled: ['glm-5.3'], extra: [{ id: 'glm-5.3-flash' }], overrides: {} }))

  const after = read()
  assert.notEqual(after, before, 'a changed fact must produce fresh facts')
  assert.equal(after.activeSubscription, 'sub-2')
  assert.deepEqual(after.subscriptions.map((sub) => sub.id), ['default', 'sub-2'])
  assert.equal(after.subscriptions[0].label, 'whoiszzj@outlook.com',
    'the default row is named from `displayName` — the same volatile write')
  assert.deepEqual(after.subscriptions.map((sub) => sub.apiKeyRef),
    ['OPENCODE_GO_WHOISZZJ_OUTLOOK_COM', 'OPENCODE_GO_WITHZZJ_GMAIL_COM'],
    'each row keeps its own credential slot — the whole point of the switch')
  assert.deepEqual(after.models.disabled, ['glm-5.3'], 'the model set is part of the same live read')
  assert.deepEqual(Object.keys(after.models.extra), ['glm-5.3-flash'])

  // ...and a second read of the NEW facts is stable again.
  assert.equal(read(), after)
})

test('an invalid snapshot keeps the last good facts; the first one still throws', () => {
  let raw = { baseURL: 'https://example.test/v1' }
  const invalid = []
  const read = createOptionsReader(() => raw, { onInvalid: (error) => invalid.push(error) })

  const good = read()
  assert.equal(good.baseURL, 'https://example.test/v1')

  raw = { baseURL: 'ftp://not-http' }
  assert.equal(read(), good, 'a rejected snapshot never replaces the facts a request is using')
  assert.equal(invalid.length, 1)
  assert.match(invalid[0].message, /baseURL must be an absolute http\(s\) URL/)

  // The FIRST read is the loud one: a structurally invalid composition must fail
  // at load, not at the first request.
  assert.throws(() => createOptionsReader(() => ({ baseURL: 'ftp://not-http' }))(),
    /baseURL must be an absolute http\(s\) URL/)
})

test('the host half reads its facts through the live reader', () => {
  // The wiring itself cannot load under bare `node --test` (it wants a profile),
  // so this is a source guard, like `tests/subscriptions-wiring`: the one place
  // the stale-settings bug lived is the memo in `apply`, and it must not come
  // back in either of its two shapes.
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(index, /createOptionsReader\(\(\) => current\(\)/)
  for (const stale of ['lastRaw', 'raw === lastRaw']) {
    assert.ok(!index.includes(stale), `the identity memo (${stale}) is the 0.2.0 stale-config bug`)
  }
})
