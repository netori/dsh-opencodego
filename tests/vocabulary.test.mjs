/**
 * The vocabulary drift guard between this plugin's two halves.
 *
 * The browser half cannot import the host half (it is served as a standalone
 * bundle), so `src/client/vocab.js` is a deliberate second copy of the words the
 * page and the host must agree on — the model-set keys, the protocols, the
 * thinking levels, the session-header union. This test asserts the copy is
 * EXTENSIONALLY equal to the host's own exports (`src/vocab.js`,
 * `src/models.js`), so a new protocol or key added on one side cannot silently
 * leave the settings page offering a value the host rejects, or hiding one it
 * accepts.
 *
 * @module tests/vocabulary
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONFIGURABLE_INPUT_MODALITIES as HOST_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS as HOST_LEVELS,
  MODEL_EXTRA_KEYS as HOST_EXTRA_KEYS,
  MODEL_OVERRIDE_KEYS as HOST_OVERRIDE_KEYS,
  MODEL_SET_KEYS as HOST_SET_KEYS,
} from '../src/models.js'
// `src/vocab.js` is host-free (no host package imports), so a bare
// `node --test` can read the host's own spellings. `src/config.js` is NOT
// importable here: it pulls `@deepseek-ai/schemastery`, which only resolves
// inside an installed profile.
import {
  HOST_THINKING_LEVELS,
  SESSION_HEADER_MODES as HOST_SESSION_HEADER_MODES,
  SUPPORTED_PROTOCOLS as HOST_PROTOCOLS,
} from '../src/vocab.js'
import {
  ADD_MODEL_HINT,
  CONFIGURABLE_INPUT_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS,
  CREDENTIAL_REF_PATTERN as CLIENT_CREDENTIAL_REF_PATTERN,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_SESSION_HEADER,
  DEFAULT_SUB_ID as CLIENT_DEFAULT_SUB_ID,
  DEFAULT_SUB_LABEL as CLIENT_DEFAULT_SUB_LABEL,
  FETCH_APPLY,
  FETCH_DESCRIPTION,
  LEGACY_API_KEY_WARNING,
  MODEL_EXTRA_KEYS,
  MODEL_OVERRIDE_KEYS,
  MODEL_SET_KEYS,
  SESSION_HEADER_HINT,
  SETTINGS_NS,
  SESSION_HEADER_MODES,
  SUBSCRIPTION_ENTRY_KEYS as CLIENT_ENTRY_KEYS,
  SUBSCRIPTION_ID_PATTERN as CLIENT_SUB_ID_PATTERN,
  SUBS_DESCRIPTION,
  SUPPORTED_PROTOCOLS,
  USAGE_WINDOW_KEYS as CLIENT_USAGE_WINDOW_KEYS,
} from '../src/client/vocab.js'
import { subscriptionSlotOf } from '../src/client/logic.js'
import {
  CREDENTIAL_REF_PATTERN,
  DEFAULT_SUB_ID,
  DEFAULT_SUB_LABEL,
  normalizeSubscriptions,
  refForSubscriptionId,
  refForSubscriptionLabel,
  SUBSCRIPTION_ENTRY_KEYS,
  SUBSCRIPTION_ID_PATTERN,
  USAGE_WINDOW_KEYS,
} from '../src/subs.js'

/** One array compared as a set, so ordering differences are not drift. */
function sorted(value) {
  return [...value].sort()
}

test('the client model-set vocabulary equals the host primitives', () => {
  assert.deepEqual(sorted(MODEL_SET_KEYS), sorted(HOST_SET_KEYS))
  assert.deepEqual(sorted(MODEL_EXTRA_KEYS), sorted(HOST_EXTRA_KEYS))
  assert.deepEqual(sorted(MODEL_OVERRIDE_KEYS), sorted(HOST_OVERRIDE_KEYS))
  assert.deepEqual(sorted(CONFIGURABLE_INPUT_MODALITIES), sorted(HOST_MODALITIES))
  assert.deepEqual(sorted(CONFIGURABLE_THINKING_LEVELS), sorted(HOST_LEVELS))
  // `off` is expressible only by omitting the reasoning option, so it must NOT
  // appear in the configurable list on either side.
  assert.ok(!CONFIGURABLE_THINKING_LEVELS.includes('off'))
  assert.ok(HOST_THINKING_LEVELS.includes('off'))
})

test('the client protocol/session vocabulary equals the host vocabulary', () => {
  assert.deepEqual(sorted(SUPPORTED_PROTOCOLS), sorted(HOST_PROTOCOLS))
  assert.deepEqual(sorted(SESSION_HEADER_MODES), sorted(HOST_SESSION_HEADER_MODES))
})

test('the namespace and the defaults the page pre-fills match the host', async () => {
  const { readFile } = await import('node:fs/promises')
  // The namespace and the defaults live in `config.js`, which imports the host
  // schemastery package; read them from the source instead of importing it.
  const source = await readFile(new URL('../src/config.js', import.meta.url), 'utf8')
  const ns = /export const NS = '([^']+)'/u.exec(source)?.[1]
  const apiKeyEnv = /export const DEFAULT_API_KEY_ENV = '([^']+)'/u.exec(source)?.[1]
  const baseURL = /export const DEFAULT_BASE_URL = '([^']+)'/u.exec(source)?.[1]
  const sessionHeader = /export const DEFAULT_SESSION_HEADER = '([^']+)'/u.exec(source)?.[1]
  assert.equal(SETTINGS_NS, ns)
  assert.equal(DEFAULT_API_KEY_ENV, apiKeyEnv)
  assert.equal(DEFAULT_BASE_URL, baseURL)
  assert.equal(DEFAULT_SESSION_HEADER, sessionHeader)
  assert.equal(DEFAULT_SESSION_HEADER, 'x-opencode-session')
})

test('the page carries its warnings and its selection promise verbatim', () => {
  // The picker's copy is a PROMISE (应用即生效, no second save), and the add
  // hint promises the official facts join automatically. Pinning the text here
  // is what stops a later edit from quietly softening either claim.
  assert.match(FETCH_APPLY, /应用/u)
  // The picker shows a MEMBERSHIP list; the copy must not claim it shows
  // capability values, because it no longer does.
  assert.match(FETCH_DESCRIPTION, /不显示能力值/u)
  assert.match(FETCH_DESCRIPTION, /立即生效/u)
  assert.match(ADD_MODEL_HINT, /内置模型状态/u)
  assert.match(LEGACY_API_KEY_WARNING, /明文/u)
  assert.match(SESSION_HEADER_HINT, /RFC 7230/u)
})

test('the built client bundle inlines the same vocabulary (it cannot import the host)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const word of ['openai-responses', 'anthropic-messages', 'session-id', 'replaceDiscovered', 'reasoningEfforts', 'opencode-go-native/usage', 'SUBSCRIPTION_ID_PATTERN']) {
    assert.ok(source.includes(word), `the bundle does not mention ${word}`)
  }
  // The bundle NAMES the credential store on purpose: that is the promise the
  // API-key field makes ("the value goes to .credentials.yaml, not the settings
  // document"). What must never appear is a credential VALUE — there is no
  // literal token here, and no code path that reads one back into a form.
  assert.ok(source.includes('.credentials.yaml'), 'the page must say where the key goes')
  assert.ok(!/sk-[A-Za-z0-9]{16,}/u.test(source), 'no literal token may be inlined into the bundle')
})

/* ── subscriptions + balance (0.8) ─────────────────────────────────────── */

test('the client subscription vocabulary equals the host primitives', () => {
  assert.deepEqual(CLIENT_USAGE_WINDOW_KEYS, USAGE_WINDOW_KEYS)
  assert.equal(CLIENT_DEFAULT_SUB_ID, DEFAULT_SUB_ID)
  assert.equal(CLIENT_DEFAULT_SUB_LABEL, DEFAULT_SUB_LABEL)
  assert.deepEqual(CLIENT_ENTRY_KEYS, [...SUBSCRIPTION_ENTRY_KEYS])
  assert.equal(CLIENT_SUB_ID_PATTERN.source, SUBSCRIPTION_ID_PATTERN.source)
  assert.equal(CLIENT_CREDENTIAL_REF_PATTERN.source, CREDENTIAL_REF_PATTERN.source)
})

test('the page derives the SAME credential slot the host resolves', () => {
  // The page shows the slot name it is about to write to; the host resolves that
  // name. Two implementations of "OPENCODE_GO_<NAME-SLUG>" that drift would mean
  // the page promising a slot the route never reads — so both the slug and the
  // unnamed-row fallback are compared here.
  for (const label of ['me@example.com', 'work@example.com', 'Work号', 'a-b.c', '  spaced  ', '默认']) {
    assert.equal(
      subscriptionSlotOf({ id: 'work', label }),
      refForSubscriptionLabel(label) ?? refForSubscriptionId('work'),
      `the page and the host disagree about "${label}"`,
    )
  }
  // The id-derived spelling is the fallback for a row with no usable name, and it
  // is the row's legacy ref on the host side.
  assert.equal(subscriptionSlotOf({ id: 'sub-2', label: '默认' }), refForSubscriptionId('sub-2'))
  assert.equal(refForSubscriptionLabel('默认'), undefined)
  const [, row] = normalizeSubscriptions([{ id: 'sub-2', label: 'Work号' }], { apiKeyEnv: 'MAIN' })
  assert.equal(row.apiKeyRef, 'OPENCODE_GO_WORK')
  assert.deepEqual(row.fallbackRefs, ['OPENCODE_GO_SUB_2'])
  // The LIVE slot (the top-level reference the active key is copied into) is
  // never a row's storage: a row whose name would derive it is refused.
  assert.throws(
    () => normalizeSubscriptions([{ id: 'work', label: 'api key' }], { apiKeyEnv: 'OPENCODE_GO_API_KEY' }),
    /LIVE slot/,
  )
})

test('the subscription card copy promises the one-active rule and the bars', () => {
  // The list is the page top and switching is one click; the balance is the
  // gateway's own answer per key. Both are claims, so both are pinned.
  assert.match(SUBS_DESCRIPTION, /只有一条生效/u)
  assert.match(SUBS_DESCRIPTION, /点哪一行就切到哪一行/u)
  assert.match(SUBS_DESCRIPTION, /余额/u)
  assert.match(SUBS_DESCRIPTION, /5 小时/u)
  assert.match(SUBS_DESCRIPTION, /复制到/u)
  assert.match(SUBS_DESCRIPTION, /立即生效/u)
  // Every existing row keeps its own credential; only the ACTIVE one is spent.
  assert.equal(normalizeSubscriptions([{ id: 'work' }], { apiKeyEnv: 'K' }).length, 2)
})

