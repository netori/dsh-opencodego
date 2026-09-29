/**
 * The built browser half, exercised as the web module loader would load it.
 *
 * This is the evidence that makes "the page works" checkable on a machine with
 * no browser: `lib/client.js` is evaluated with a `window.__ModuleLoader__` stub
 * that captures the registration, its factory is materialized with a `react`
 * stand-in (seed-word shaped), and the section is driven through the settings,
 * credential, and route faces the registration built.
 *
 * What it does NOT prove, and says so: the loader serves the bundle, and the
 * shell paints it. Those were covered by the acceptance harness that used to ship here.
 * (curl for the served script + the route payloads) and by the honest
 * "UI not rendered in a real browser" note in PROGRESS.md.
 *
 * @module tests/client-bundle
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const MANIFEST = new URL('../package.json', import.meta.url)

/**
 * Evaluate the built bundle and answer its registered factory.
 * @returns {{id: string, factory: Function, source: string}} the registration.
 */
async function loadRegistration() {
  let source
  try {
    source = await readFile(BUNDLE, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(
      'tests/client-bundle.test.mjs: lib/client.js is missing — run `npm run build` first '
      + '(the published `npm test` runs after `prepack`, which builds it)',
    )
  }
  let registration
  const window = {
    __ModuleLoader__: { load: (entry) => { registration = entry } },
  }
  // The bundle is a browser file; the only globals it touches are these two.
  globalThis.window = window
  try {
    // eslint-disable-next-line no-new-func -- the point IS to evaluate the artifact
    new Function('window', source)(window)
  } finally {
    delete globalThis.window
  }
  assert.ok(registration !== undefined, 'the bundle registered nothing with __ModuleLoader__.load')
  return { ...registration, source }
}

/** Drain the microtask queue (every `.then` a test fetch answers with). */
async function drainMicrotasks() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

/**
 * Wait out the page's auto-save debounce, drain what it queued, and re-render.
 *
 * The page has no 保存 button any more: a change IS the commit, batched by a
 * ~400ms debounce. A test that types into a field therefore has to let that
 * timer fire — and it is the REAL timer, so this is the same path a browser
 * takes. `ms` is a knob for the immediate acts (add/remove/restore), which
 * schedule with a zero-length delay.
 */
async function settleWrites(page, ms = 450) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await drainMicrotasks()
  return page.reload()
}

/**
 * Rename the DEFAULT subscription through its own row: the page has no separate
 * `displayName` control any more, so the name lives where the subscription does.
 * @param {object} page - the harness page.
 * @param {string} value - the new name.
 */
async function renameDefault(page, value) {
  if (page.control('subscriptions[0].label') === undefined) {
    page.control('subscriptions[0].toggle').props.onClick()
    await page.reload()
  }
  page.control('subscriptions[0].label').props.onChange({ target: { value } })
  await page.reload()
}

/**
 * A `react` stand-in with just enough fidelity to drive one section: hooks keep
 * state across renders, `useEffect` runs synchronously, and `createElement`
 * builds a plain tree that can be searched as text.
 * @returns {object} the fake module.
 */
function fakeReact() {
  const states = []
  const refs = []
  const effectDeps = []
  let changed = false
  let cursor = 0
  let effectsFired = 0
  const effectCount = () => effectsFired
  /**
   * Evaluate function components inline, the way React does.
   *
   * Without this the tree keeps `{ type: TextField, props: { field: … } }` nodes
   * and no real `<input>` ever exists — a harness that cannot see the leaves
   * cannot check what the page renders.
   */
  const build = (type, props, children) => {
    if (typeof type === 'function') {
      const produced = type(props ?? {})
      if (produced === undefined || produced === null) return produced
      return build(produced.type, produced.props, produced.children)
    }
    // Children FLATTEN, like the DOM appending an array-valued child: the page
    // writes `[cond ? option : null, options.map(...)]`, and a nested array would
    // otherwise hide every `<option>` from the search helpers.
    return { type, props: props ?? {}, children: flatten(children ?? []) }
  }
  /** Resolve component calls inside a child list and flatten nested arrays. */
  const flatten = (list) => {
    const out = []
    for (const child of list) {
      if (child === undefined || child === null || typeof child === 'boolean') continue
      if (Array.isArray(child)) {
        out.push(...flatten(child))
        continue
      }
      if (typeof child === 'object' && 'type' in child && 'props' in child) {
        out.push(build(child.type, child.props, child.children))
        continue
      }
      out.push(child)
    }
    return out
  }
  const api = {
    createElement: (type, props, ...children) => build(type, props, children),
    Fragment: 'Fragment',
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(states[index]) : next
        // `Object.is`, like React: a value that is only deep-equal does not
        // re-render. That is what makes the section's catalogue effect converge.
        if (!Object.is(value, states[index])) {
          states[index] = value
          changed = true
        }
      }
      return [states[index], set]
    },
    useRef: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    /**
     * Effects with React's dependency semantics.
     *
     * This is not a convenience. A section whose effects re-subscribe on every
     * render is a real bug, and a harness that ran every effect every time would
     * HIDE it (handing back a deep-equal answer forever instead of converging).
     * So the dependency list is honored: `[]` runs once, an effect whose
     * dependencies never move does not run again, and a component that gets this
     * wrong spins here until `settle` gives up and says so.
     */
    useEffect: (effect, deps) => {
      // Hook position, like React's hook order — NOT a per-pass counter, or the
      // first effect would look new on every render.
      const index = cursor
      cursor += 1
      const previous = effectDeps[index]
      const next = deps === undefined ? undefined : [...deps]
      const stale = previous === undefined
        || next === undefined
        || next.length !== previous.length
        || next.some((value, position) => !Object.is(value, previous[position]))
      effectDeps[index] = next
      if (stale) {
        effectsFired += 1
        effect()
      }
      return undefined
    },
    useMemo: (factory) => factory(),
    /**
     * Render like React does around effects, then drain the microtask queue, over
     * and over until nothing changed.
     */
    render: (Component, props) => {
      cursor = 0
      effectsFired = 0
      changed = false
      return Component(props)
    },
    settle: async (Component, props) => {
      let tree
      const pass = async () => {
        cursor = 0
        effectsFired = 0
        changed = false
        tree = Component(props)
        await drainMicrotasks()
        return changed || effectsFired > 0
      }
      let moved = await pass()
      for (let guard = 0; guard < 200 && moved; guard += 1) {
        moved = await pass()
      }
      if (moved) throw new Error('the section never settled after 200 passes (an effect is re-subscribing every render?)')
      void effectCount
      return tree
    },
  }
  return api
}

/** Every string a rendered tree contains, in order. */
function texts(node, out = []) {
  if (node === undefined || node === null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const entry of node) texts(entry, out)
    return out
  }
  if (typeof node === 'object') {
    // The stylesheet is text but not COPY; searching it would make assertions
    // like "the page says RFC 7230" trivially true.
    if (node.type === 'style') return out
    // This page puts copy in PROPS (`TextField` renders `label`, `hint` and the
    // inline `error` itself), so the searchable text is children + those props.
    // `value` is deliberately excluded: it is data the operator typed, not copy.
    for (const key of ['label', 'hint', 'error', 'placeholder', 'data-ocg-field']) {
      const value = node.props?.[key]
      if (typeof value === 'string') out.push(value)
    }
    if (Array.isArray(node.children)) for (const child of node.children) texts(child, out)
  }
  return out
}

/** Every element of one type in a rendered tree. */
function elements(node, type, out = []) {
  if (node === undefined || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) elements(entry, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) elements(child, type, out)
  return out
}

/** The one control carrying a `data-ocg-field` name. */
function control(tree, name) {
  if (tree === undefined) return undefined
  return find(tree, (node) => node.props?.['data-ocg-field'] === name)[0]
}

/** Every element whose props satisfy the predicate. */
function find(node, predicate, out = []) {
  if (node === undefined || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) find(child, predicate, out)
  return out
}

/** One catalogue entry as the enriched route answers it. */
function modelOf(id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: 'openai-completions',
    protocolSource: 'models.dev-npm',
    snapshotKnown: true,
    // Capability facts are only shown once a sync measured them, so a fixture
    // that expects chips is a synced model.
    synced: true,
    defaults: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    effective: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, reasoningEfforts: ['low', 'high'] },
    ...overrides,
  }
}

/** The `SettingsNamespaceView` the host would answer with. */
function describeAnswer(overrides = {}) {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: 'llm-deepseek', schema: {}, value: {}, applies: 'restart', secrets: [], revision: 1 },
      {
        ns: 'opencode-go-native',
        schema: { type: 'object', properties: { models: {} } },
        value: {
          baseURL: 'https://opencode.ai/zen/go/v1',
          apiKeyEnv: 'OPENCODE_GO_API_KEY',
          sessionHeader: 'x-opencode-session',
          sessionHeaderEnabled: true,
          sessionHeaderMode: 'session-id',
          sync: true,
          models: { disabled: [], extra: [], overrides: {}, replaceDiscovered: false },
        },
        user: {},
        applies: 'live',
        secrets: [],
        revision: 11,
        ...overrides,
      },
    ],
  }
}

/** A recording harness: one section, driven by explicit answers. */
async function harness({
  describe = describeAnswer(),
  catalogue,
  discovery,
  diagnostics,
  facts,
  refreshError,
  credential = { configured: false, writable: true },
  failMutate,
  failDiscover,
  failCredentialSet,
  sync,
  usage,
} = {}) {
  const { factory } = await loadRegistration()
  const calls = { describe: 0, mutate: [], catalogue: [], discover: [], urls: [], credentialSet: [], credentialUnset: [], credentialDescribe: [] }
  const React = fakeReact()
  const reactModule = { default: React, ...React }
  const exports = factory((specifier) => {
    assert.equal(specifier, 'react', `the bundle required an unexpected external: ${specifier}`)
    return reactModule
  })

  const registrations = []
  const injections = []
  // The live settings document as the host would keep it: the mutate stub
  // APPLIES the ops it receives (to the USER layer and the resolved layer) and
  // answers with the new namespace view, so a path-addressed write round-trips
  // exactly like the host's resolve-against-stored semantics.
  const document = JSON.parse(JSON.stringify(describe))
  const setPath = (root, path, value) => {
    let node = root
    for (const key of path.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
      node = node[key]
    }
    node[path[path.length - 1]] = value
  }
  const unsetPath = (root, path) => {
    let node = root
    for (const key of path.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) return
      node = node[key]
    }
    delete node[path[path.length - 1]]
  }
  const ctx = {
    remote: {
      settings: {
        describe: () => {
          calls.describe += 1
          // The host answers a `RemoteResult` envelope, not the bare value:
          // `{ ok: true, value }` (`@deepseek-ai/dsh-typert-protocol`). A stub
          // that hands back the bare view is exactly what let the missing
          // unwrap ship, so the double speaks the wired shape.
          return Promise.resolve({ ok: true, value: document })
        },
        mutate: (ns, ops, revision) => {
          calls.mutate.push({ ns, ops, revision })
          if (failMutate !== undefined) return Promise.resolve({ ok: false, error: failMutate })
          const next = document.namespaces[1]
          for (const op of ops) {
            if (op.op === 'set') {
              setPath(next.user ??= {}, op.path, op.value)
              setPath(next.value ??= {}, op.path, op.value)
            } else {
              unsetPath(next.user ??= {}, op.path)
              unsetPath(next.value ??= {}, op.path)
            }
          }
          next.revision = (next.revision ?? 0) + 1
          return Promise.resolve({ ok: true, value: JSON.parse(JSON.stringify(next)) })
        },
      },
      credentials: {
        describe: (refs) => {
          calls.credentialDescribe.push([...refs])
          return Promise.resolve({
            ok: true,
            value: Object.fromEntries(refs.map((ref) => [ref, credential])),
          })
        },
        set: (ref, value) => {
          calls.credentialSet.push({ ref, value })
          if (failCredentialSet !== undefined) return Promise.resolve({ ok: false, error: failCredentialSet })
          return Promise.resolve({ ok: true, value: undefined })
        },
        unset: (ref) => {
          calls.credentialUnset.push(ref)
          return Promise.resolve({ ok: true, value: undefined })
        },
      },
    },
    slots: {
      inject: (name, callback) => injections.push({ name, callback }),
      register: (options, Component) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }

  const originalFetch = globalThis.fetch
  let catalogueAnswer
  let diagnosticsAnswer
  let usageAnswer
  globalThis.fetch = async (url, options) => {
    calls.urls.push({ url, options })
    const absolute = String(url)
    if (absolute.includes('/opencode-go-native/sync')) {
      if (options?.method !== 'POST') return { status: 200, json: async () => ({ ok: true, models: {} }) }
      const wanted = JSON.parse(options.body).id
      const answer = typeof sync === 'function' ? sync(wanted) : sync?.[wanted]
      if (answer === undefined) return { status: 200, json: async () => ({ ok: false, error: { code: 'SYNC_FAILED', message: `no sync fixture for ${wanted}` } }) }
      return { status: 200, json: async () => ({ ok: true, sync: answer, saved: '/tmp/opencode-go.synced.json' }) }
    }
    if (absolute.includes('/opencode-go-native/usage')) {
      usageAnswer ??= usage ?? { ok: true, subs: [] }
      return { status: 200, json: async () => usageAnswer }
    }
    if (absolute.includes('/diagnostics')) {
      if (diagnostics === undefined) throw new Error('no diagnostics fixture')
      diagnosticsAnswer ??= diagnostics
      return { status: 200, json: async () => diagnosticsAnswer }
    }
    if (options?.method === 'POST') {
      if (failDiscover !== undefined) return { status: 200, json: async () => failDiscover }
      return { status: 200, json: async () => ({ ok: true, models: discovery ?? catalogue ?? [] }) }
    }
    catalogueAnswer ??= {
      ok: true,
      source: 'cache',
      ...(facts === undefined ? {} : { facts }),
      ...(refreshError === undefined ? {} : { refreshError }),
      models: catalogue ?? [],
    }
    return { status: 200, json: async () => catalogueAnswer }
  }

  const restoreFetch = () => { globalThis.fetch = originalFetch }
  {
    exports.apply(ctx)
    const injected = injections[0]
    assert.ok(injected !== undefined, 'apply() never injected into settings.section')
    injected.callback()
    const registration = registrations[0]
    assert.ok(registration !== undefined, 'slots.register was never called')
    const props = {
      close: () => {},
      ...registration.options.inject(),
    }
    const page = {
      exports,
      registration,
      registrations,
      injections,
      registrationCount: registrations.length,
      props,
      calls,
      /** The most recent render's tree (reloads replace it). */
      get tree() { return page.currentTree },
      get text() { return texts(page.currentTree).join('\n') },
      get reloadTree() { return page.currentTree },
      currentTree: undefined,
      /** The one control a `data-ocg-field` name addresses. */
      control: (name) => control(page.currentTree, name),
      texts: (node) => texts(node ?? page.currentTree),
      find: (predicate) => find(page.currentTree, predicate),
      elements: (type) => elements(page.currentTree, type, []),
      reload: async () => {
        page.currentTree = await React.settle(registration.Component, props)
        return page.currentTree
      },
      restore: restoreFetch,
    }
    page.currentTree = await React.settle(registration.Component, props)
    return page
  }
}

// ── the artifact itself ────────────────────────────────────────────────────

test('the bundle is a ModuleLoader registration for this package, with no external but react', async () => {
  const { id, source } = await loadRegistration()
  assert.equal(id, 'dsh-opencodego')
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  assert.equal(id, manifest.name, 'the registration id must be the package name the loader keys the row by')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.external, [], 'a shell seed word needs no graph edge')
  const requires = [...source.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
  // The factory must not execute module bodies at parse time: only the
  // registration call may run while the script is evaluated.
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{ id: /mu)
})

test('the manifest declares what the host loader requires of a client package', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  assert.equal(typeof manifest.dsh.client.inject, 'object')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('lib'))
})

test('materializing the factory answers the cordis plugin face', async () => {
  const { factory, source } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  // `remote.settings` and `remote.credentials` are the host's nested Remote
  // namespace service keys, which cordis requires to be declared with their dot
  // (see src/client/index.js).
  assert.deepEqual(exports.inject, ['remote', 'remote.credentials', 'remote.settings', 'slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.ok(source.includes('opencode-go-native'))
})

// ── registration ───────────────────────────────────────────────────────────

test('apply() registers exactly one settings.section with our id and label', async () => {
  const page = await harness()
  assert.equal(page.registrationCount, 1)
  assert.equal(page.injections[0].name, 'settings.section')
  assert.equal(page.registration.options.name, 'settings.section')
  assert.equal(page.registration.options.id, 'opencode-go-native')
  assert.equal(page.registration.options.label(), 'OpenCode Go')
  const face = page.registration.options.inject()
  assert.equal(face.settingsNamespace, 'opencode-go-native')
  for (const method of ['describeSettings', 'mutateSettings', 'storeCredential', 'removeCredential', 'catalogue', 'discoverDraft', 'diagnostics', 'usage']) {
    assert.equal(typeof face.api[method], 'function', method)
  }
  page.restore()
})

// ── reading the settings ───────────────────────────────────────────────────

test('the section reads its namespace and renders the subscription list as the page top', async () => {
  const page = await harness({
    usage: {
      ok: true,
      subs: [{
        id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_API_KEY', isDefault: true, active: true,
        configured: true, source: 'file', usage: {},
      }],
    },
  })
  assert.equal(page.calls.describe, 1)
  assert.match(page.text, /OpenCode Go/u)
  // The namespace/revision meta line is GONE, and there is no STANDALONE
  // reference or key input: since 0.8.2 the top of the page IS the subscription
  // list, one row per key, and everything about a key lives in its row.
  assert.ok(!page.text.includes('revision'), 'no revision meta on the page')
  assert.ok(!page.text.includes('命名空间'), 'no namespace meta on the page')
  assert.equal(page.control('apiKeyEnv'), undefined, 'no bare top-level reference control')
  assert.equal(page.control('apiKey'), undefined, 'no bare top-level API-key control')
  assert.notEqual(page.control('subscriptions[0].toggle'), undefined, 'the default subscription row exists')
  assert.equal(page.control('subs.title').children[0], '订阅', 'the list is the page top')
  assert.equal(page.control('subs.count').children[0], '1')
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  assert.notEqual(page.control('subscriptions[0].apiKey'), undefined, 'the expanded default row carries the key field')
  assert.notEqual(page.control('subscriptions[0].slot'), undefined, 'and names the credential slot it writes to')
  // The credential VALUE never appears: the page only knows the state.
  assert.match(page.text, /已存密钥/u, 'the stored/not-stored fact is a one-word pill')
  assert.ok(
    page.find((node) => typeof node.props?.title === 'string' && /来源 file/.test(node.props.title)).length > 0,
    'where the value came from stays in the tooltip',
  )
  assert.ok(
    page.find((node) => typeof node.props?.title === 'string' && /\.credentials\.yaml/.test(node.props.title)).length > 0,
    'the exact store path stays one hover away',
  )
  // The key field carries NO hint line: the store promise lives in the slot
  // tooltip above and in the pill, and the field itself stays one clean input
  // under 「名字」(the page adds no explanatory rows).
  assert.ok(!page.text.includes('不落明文'), 'the key field has no hint paragraph')
  assert.equal(page.control('subscriptions[0].apiKey').props.hint, undefined)
  // The key field is a password input whose own VALUE is empty.
  const key = page.control('subscriptions[0].apiKey')
  assert.equal(key.props.type, 'password')
  assert.equal(key.props.value, '')
  assert.ok(page.control('subscriptions[0].clearCredential') !== undefined, 'a configured credential can be cleared')
  page.restore()
})

test('an unconfigured credential says so and offers no clear button', async () => {
  const page = await harness({
    usage: {
      ok: true,
      subs: [{ id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_API_KEY', isDefault: true, active: true, configured: false, usage: {} }],
    },
  })
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  assert.match(page.text, /未存密钥/u)
  assert.equal(page.control('subscriptions[0].clearCredential'), undefined)
  page.restore()
})

test('a pre-0.6.0 plain-text apiKey is warned about, never rendered', async () => {
  const page = await harness({
    describe: describeAnswer({
      user: { apiKey: 'sk-LEGACY-not-a-real-key' },
      secrets: [{ path: ['apiKey'], set: true }],
    }),
  })
  assert.match(page.text, /设置文件里还有旧版的明文 apiKey/u)
  // No control on the page carries the legacy token, expanded or not.
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  const values = page.find((node) => typeof node.props?.value === 'string').map((node) => node.props.value)
  assert.ok(!values.some((value) => value.includes('sk-LEGACY')), 'the legacy token is never rendered into a control')
  page.restore()
})

test('a missing namespace says so instead of rendering an empty form', async () => {
  const page = await harness({
    describe: { writable: true, hasDocument: true, namespaces: [{ ns: 'other', schema: {}, value: {}, revision: 1, secrets: [] }] },
  })
  assert.match(page.text, /没有命名空间 opencode-go-native/u)
  assert.match(page.text, /重试/u)
  page.restore()
})

test('a describe() refusal is shown verbatim and offers a retry', async () => {
  const { factory } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  const ctx = {
    remote: {
      settings: { describe: () => Promise.reject(Object.assign(new Error('provider absent'), { code: 'gateway/internal' })) },
      credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => { ctx.Component = Component; ctx.options = options; return () => {} },
    },
  }
  exports.apply(ctx)
  ctx.options.inject()
  const tree = await React.settle(ctx.Component, { close: () => {}, ...ctx.options.inject() })
  const text = texts(tree).join('\n')
  assert.match(text, /gateway\/internal: provider absent/u)
  assert.match(text, /重试/u)
})

test('the host Remote error ARM (ok: false) is shown verbatim too, not swallowed', async () => {
  const { factory } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  const ctx = {
    remote: {
      settings: {
        describe: () => Promise.resolve({
          ok: false,
          error: Object.assign(new Error('no settings provider is mounted'), { code: 'gateway/internal' }),
        }),
      },
      credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => { ctx.Component = Component; ctx.options = options; return () => {} },
    },
  }
  exports.apply(ctx)
  ctx.options.inject()
  const tree = await React.settle(ctx.Component, { close: () => {}, ...ctx.options.inject() })
  const text = texts(tree).join('\n')
  assert.match(text, /gateway\/internal: no settings provider is mounted/u)
  assert.match(text, /重试/u)
})

// ── the model directory ────────────────────────────────────────────────────

test('the model list shows every active model WITH its official facts, and no data-layer words', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha', { name: 'Alpha' }), modelOf('retired')],
    describe: describeAnswer({
      user: {
        models: {
          disabled: ['retired'],
          extra: [{ id: 'hand', name: 'Hand Declared' }],
          overrides: { alpha: { maxTokens: 2048 } },
          replaceDiscovered: false,
        },
      },
    }),
  })
  assert.match(page.text, /模型（已启用/u)
  assert.ok(page.control('action.fetch') !== undefined, 'the 获取可用模型 action exists')
  assert.ok(page.control('action.toggleAdd') !== undefined, 'the by-id adder exists')
  assert.ok(page.control('model.alpha.toggle') !== undefined)
  assert.ok(page.control('model.hand.toggle') !== undefined)
  assert.equal(page.control('model.retired.toggle'), undefined, 'a stopped model has no row at all')
  // No per-row "已自定义" badge: which row carries an override is visible in the
  // row's own expanded fields, and a badge on every row was noise the operator
  // asked to have removed.
  assert.ok(!page.text.includes('已自定义'), 'no row wears a customized badge')
  // The OFFICIAL facts ride the row: no expanding, no blank fields.
  const chips = page.find((node) => node.props?.['data-ocg-chips'] === 'alpha')
  assert.equal(chips.length, 1, 'the row renders exactly one capability-chip line')
  const chipText = texts(chips[0]).join(' ')
  assert.match(chipText, /openai-completions/u)
  assert.match(chipText, /上下文 1M/u)
  assert.match(chipText, /输出 131K/u)
  assert.match(chipText, /输入 text\+image/u)
  assert.match(chipText, /思考 low\/high/u)
  // The words the operator asked to be rid of: GONE from the page.
  // `models.dev` is deliberately NOT banned any more (0.9.0): the declared
  // numbers are read from it at runtime, so the page naming that source is the
  // honest thing to do. What stays banned is the data-layer vocabulary that made
  // the page read like a control panel for an ETL job.
  for (const word of ['端点', '手写', '已排除', '冻结', '恢复默认模型', '刷新目录', '目录来源', '正在使用端点模型', '已自定义模型目录', '未收录']) {
    assert.ok(!page.text.includes(word), `the page must not speak "${word}"`)
  }
  // …and the provenance line names the live source together with its fallback.
  assert.match(page.text, /models\.dev/u)
  assert.match(page.text, /运行期同步/u)
  page.restore()
})

test('every listed model shows its EFFECTIVE numbers — no catalog-membership labels', async () => {
  // Two sources only: the gateway list and the plugin's state. An id the
  // bundled state does not know is not special-cased with a "not catalogued"
  // label; it simply carries the values dsh would load (the conservative
  // defaults until an operator corrects the row).
  const page = await harness({
    catalogue: [modelOf('brand-new', { snapshotKnown: false })],
  })
  const chips = page.find((node) => node.props?.['data-ocg-chips'] === 'brand-new')
  const chipText = texts(chips[0]).join(' ')
  assert.match(chipText, /上下文 1M/u, 'the effective numbers ride the row whatever their source')
  assert.ok(!chipText.includes('未收录'), 'no membership label')
  page.restore()
})

test('the source line names the two layers, and a failed gateway refresh is shown', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  // 0.9.0: the declaration layer is live (models.dev, read at runtime) with the
  // bundled copy as the offline floor — the line promises both, verbatim.
  assert.match(page.text, /模型名单来自网关 \/models；能力值优先取 models\.dev 的最新声明/u)
  assert.match(page.text, /回退到插件内置数据/u)
  assert.equal(page.control('action.resetModels'), undefined, 'there is no reset affordance any more')
  page.restore()
  const stale = await harness({
    catalogue: [modelOf('alpha')],
    refreshError: 'GET https://opencode.ai/zen/go/v1/models answered HTTP 503',
  })
  assert.match(stale.text, /向网关刷新模型列表时出错/u)
  stale.restore()
})

test('the chevron expands the row into its attributes, with the EFFECTIVE values as placeholders', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  const toggle = page.control('model.alpha.toggle')
  assert.equal(toggle.props['aria-expanded'], 'false')
  toggle.props.onClick()
  await page.reload()
  assert.equal(page.control('model.alpha.toggle').props['aria-expanded'], 'true')
  for (const field of ['api', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts']) {
    assert.ok(page.control(`model.alpha.${field}`) !== undefined, `the expanded row must offer ${field}`)
  }
  // The capacity placeholders are the EFFECTIVE numbers, so an empty field
  // reads as the number the route will actually use.
  assert.equal(page.control('model.alpha.contextWindow').props.placeholder, '当前生效 1000000')
  assert.equal(page.control('model.alpha.maxTokens').props.placeholder, '当前生效 131072')
  assert.match(page.text, /当前生效：text \+ image/u)
  // An advertised row cannot be renamed: the endpoint names its own models.
  assert.equal(page.control('model.alpha.name'), undefined)
  page.restore()
})

test('editing an expanded advertised row writes an override into the draft', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  page.control('model.alpha.toggle').props.onClick()
  await page.reload()
  page.control('model.alpha.maxTokens').props.onChange({ target: { value: '4096' } })
  await page.reload()
  assert.equal(page.control('model.alpha.maxTokens').props.value, '4096')
  // No save button: the edit commits itself once the operator pauses. The
  // override lands as models.overrides, never as an extra row.
  assert.equal(page.control('action.save'), undefined, 'the 保存 button is gone: a change IS the commit')
  await settleWrites(page)
  assert.equal(page.calls.mutate.length, 1)
  const ops = page.calls.mutate[0].ops
  assert.ok(ops.some((op) => op.path.join('.') === 'models.overrides' && op.value.alpha.maxTokens === 4096))
  assert.ok(ops.some((op) => op.path.join('.') === 'models.extra' && op.value.length === 0))
  page.restore()
})

test('the × on a row stops the model AND saves it: selection is activation, no second click', async () => {
  const page = await harness({ catalogue: [modelOf('alpha'), modelOf('beta')] })
  page.control('model.alpha.remove').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1, 'the act wrote immediately')
  assert.deepEqual(
    page.calls.mutate[0].ops.map((op) => op.path.join('.')),
    ['models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered'],
    'a model act commits ONLY the models paths',
  )
  assert.deepEqual(page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.disabled').value, ['alpha'])
  assert.match(page.text, /已停用 alpha 并保存/u)
  assert.equal(page.control('model.alpha.toggle'), undefined, 'the stopped row is gone')
  assert.ok(page.control('model.beta.toggle') !== undefined)
  page.restore()
})

test('a stop is reversible: the same document without the exclusion comes back via the adder', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha')],
    describe: describeAnswer({ user: { models: { disabled: ['alpha'], extra: [], overrides: {}, replaceDiscovered: false } } }),
  })
  assert.equal(page.control('model.alpha.toggle'), undefined, 'an excluded model has no row')
  await page.control('action.toggleAdd').props.onClick()
  await page.reload()
  page.control('add.model.id').props.onChange({ target: { value: 'alpha' } })
  await page.reload()
  await page.control('action.addModel').props.onClick()
  await drainMicrotasks()
  await page.reload()
  const disabled = page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.disabled').value
  assert.deepEqual(disabled, [], 're-adding an advertised id clears its exclusion')
  const extra = page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.extra').value
  assert.deepEqual(extra, [], 'and does NOT declare what the endpoint already serves')
  assert.match(page.text, /已添加并启用 alpha/u)
  page.restore()
})

test('按 ID 添加 activates a model the listing does not show, in one act', async () => {
  const page = await harness({ catalogue: [modelOf('alpha')] })
  await page.control('action.toggleAdd').props.onClick()
  await page.reload()
  assert.ok(page.control('add.model.id') !== undefined)
  assert.equal(page.control('action.addModel').props.disabled, true, 'nothing typed, nothing to add')
  page.control('add.model.id').props.onChange({ target: { value: 'brand-new' } })
  await page.reload()
  assert.equal(page.control('action.addModel').props.disabled, false)
  await page.control('action.addModel').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1)
  const extra = page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.extra').value
  assert.deepEqual(extra.map((row) => row.id), ['brand-new'])
  assert.equal(extra[0].contextWindow, undefined, 'no capacity is pinned: the official facts stay inherited')
  assert.match(page.text, /已添加并启用 brand-new/u)
  assert.ok(page.control('model.brand-new.toggle') !== undefined)
  page.restore()
})

test('sessionHeaderMode offers exactly the host union', async () => {
  const page = await harness()
  const select = page.control('sessionHeaderMode')
  assert.ok(select !== undefined)
  assert.deepEqual(select.children.map((child) => child.props.value), ['session-id', 'uuid'])
  page.restore()
})

// ── writes ─────────────────────────────────────────────────────────────────

test('an edit writes only the moved fields, with the revision it read', async () => {
  const page = await harness()
  // The default subscription's name is edited in its own row (the page keeps no
  // separate `displayName` control).
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  const nameBox = page.control('subscriptions[0].label')
  assert.equal(nameBox.props.value, '')
  nameBox.props.onChange({ target: { value: 'renamed' } })
  await page.reload()
  // No button to press: the edit commits itself, with the revision it read.
  await settleWrites(page)
  assert.equal(page.calls.mutate.length, 1)
  assert.equal(page.calls.mutate[0].ns, 'opencode-go-native')
  assert.equal(page.calls.mutate[0].revision, 11)
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['displayName'], value: 'renamed' }])
  assert.deepEqual(page.calls.credentialSet, [], 'no credential was staged, so none is written')
  // The reply is adopted as the new baseline, so nothing is written twice.
  await settleWrites(page)
  assert.equal(page.calls.mutate.length, 1, 'a settled form writes nothing more')
  page.restore()
})

test('a client-side validation failure blocks the write and names the control', async () => {
  const page = await harness()
  const header = page.control('sessionHeader')
  header.props.onChange({ target: { value: 'x session' } })
  await page.reload()
  await settleWrites(page)
  assert.equal(page.calls.mutate.length, 0, 'nothing may be written while the draft is invalid')
  assert.match(page.text, /不是合法的 HTTP 头名/u)
  assert.match(page.text, /RFC 7230/u)
  page.restore()
})

test('typing an API key and leaving the field stores the credential, and never puts it in the settings ops', async () => {
  const page = await harness()
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  const key = page.control('subscriptions[0].apiKey')
  const SENTINEL = 'sk-SENTINEL-not-a-real-key'
  key.props.onChange({ target: { value: SENTINEL } })
  await page.reload()
  // Leaving the field (or Enter) is what stores it — never a keystroke, and
  // never a 保存 button.
  page.control('subscriptions[0].apiKey').props.onBlur()
  await drainMicrotasks()
  await page.reload()
  // The settings half owes nothing: the credential slot is derived from the
  // subscription's NAME (here it has none, so the id-derived spelling), and the
  // secret must never appear in a settings op.
  assert.deepEqual(page.calls.mutate, [])
  assert.deepEqual(page.calls.credentialSet, [{ ref: 'OPENCODE_GO_DEFAULT', value: SENTINEL }])
  assert.equal(page.control('subscriptions[0].apiKey').props.value, '', 'the staged secret is not kept in the form')
  page.restore()
})

test('a settings change and a staged key are two different writes', async () => {
  const page = await harness()
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  page.control('subscriptions[0].label').props.onChange({ target: { value: 'renamed' } })
  await page.reload()
  page.control('subscriptions[0].apiKey').props.onChange({ target: { value: 'sk-SENTINEL-not-a-real-key' } })
  await page.reload()
  // The secret is stored by leaving its field; the name by the debounce. Two
  // independent acts, and the settings op never carries the secret. The slot
  // follows the NAME, so the key lands under the renamed row's slot.
  page.control('subscriptions[0].apiKey').props.onBlur()
  await drainMicrotasks()
  await settleWrites(page)
  assert.equal(page.calls.mutate.length, 1)
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['displayName'], value: 'renamed' }])
  assert.deepEqual(page.calls.credentialSet, [{ ref: 'OPENCODE_GO_RENAMED', value: 'sk-SENTINEL-not-a-real-key' }])
  page.restore()
})

test('a refused credential write is reported and keeps the typed key', async () => {
  const page = await harness({ failCredentialSet: Object.assign(new Error('reference is shadowed by the environment'), { code: 'credentials/read-only' }) })
  const SENTINEL = 'sk-SENTINEL-not-a-real-key'
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  page.control('subscriptions[0].apiKey').props.onChange({ target: { value: SENTINEL } })
  await page.reload()
  page.control('subscriptions[0].apiKey').props.onBlur()
  await drainMicrotasks()
  await page.reload()
  assert.match(page.text, /密钥没写进凭据存储/u)
  assert.match(page.text, /shadowed by the environment/u)
  // The key the operator typed is STILL in the form: dropping it here would make
  // a refusal cost them the secret they just pasted.
  assert.equal(page.control('subscriptions[0].apiKey').props.value, SENTINEL)
  // Retry: leaving the field again attempts the credential once more.
  page.control('subscriptions[0].apiKey').props.onBlur()
  await drainMicrotasks()
  assert.equal(page.calls.credentialSet.length, 2, 'the credential write is retried')
  page.restore()
})

test('清除已存密钥 removes EVERY spelling of one row’s credential, and never writes settings', async () => {
  const subscriptions = [{ id: 'sub-2', label: 'work@example.com' }]
  const page = await harness({
    describe: describeAnswer({
      value: { baseURL: 'https://opencode.ai/zen/go/v1', subscriptions },
      user: { subscriptions },
    }),
    usage: {
      ok: true,
      subs: [
        { id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_DEFAULT', isDefault: true, active: true, configured: true, source: 'env', usage: {} },
        {
          id: 'sub-2',
          label: 'work@example.com',
          apiKeyRef: 'OPENCODE_GO_WORK_EXAMPLE_COM',
          // The row used to be stored under its id: clearing only the primary
          // would leave this copy behind for the request path to resurrect.
          fallbackRefs: ['OPENCODE_GO_SUB_2'],
          isDefault: false,
          active: false,
          configured: true,
          source: 'file',
          usage: {},
        },
      ],
    },
  })
  await page.reload()
  page.control('subscriptions[1].toggle').props.onClick()
  await page.reload()
  const clear = page.control('subscriptions[1].clearCredential')
  assert.ok(clear !== undefined)
  assert.match(page.text, /槽位 OPENCODE_GO_WORK_EXAMPLE_COM/u, 'the row names its OWN slot')
  await clear.props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.deepEqual(page.calls.credentialUnset, ['OPENCODE_GO_WORK_EXAMPLE_COM', 'OPENCODE_GO_SUB_2'])
  assert.deepEqual(page.calls.mutate, [], 'removing a secret is not a settings edit')
  page.restore()
})

test('a host rejection is rendered beside the control it names', async () => {
  const page = await harness({
    failMutate: Object.assign(new Error('opencode-go-native: models.extra["broken-extra"].contextWindow must be a positive integer (got: -5)'), { code: 'settings/rejected' }),
    describe: describeAnswer({
      user: { models: { disabled: [], extra: [{ id: 'broken-extra' }], overrides: {}, replaceDiscovered: false } },
    }),
  })
  page.control('model.broken-extra.toggle').props.onClick()
  await page.reload()
  page.control('model.broken-extra.contextWindow').props.onChange({ target: { value: '4096' } })
  await page.reload()
  await settleWrites(page)
  assert.equal(page.calls.mutate.length, 1)
  assert.match(page.text, /宿主拒绝了这次写入（已定位到 models\.extra\[broken-extra\]）/u)
  assert.match(page.text, /must be a positive integer/u)
  page.restore()
})

test('a revision conflict is reported as a conflict, not as a validation error', async () => {
  const page = await harness({
    failMutate: Object.assign(new Error('settings namespace "opencode-go-native" changed since it was read (expected revision 11, now 12)'), { code: 'settings/conflict' }),
  })
  await renameDefault(page, 'renamed')
  await settleWrites(page)
  assert.match(page.text, /另一个标签页先改过了/u)
  assert.match(page.text, /重新载入最新设置/u)
  page.restore()
})

// ── discovery, diagnostics ─────────────────────────────────────────────────

test('获取可用模型 shows the gateway list as a PLAIN list — no capability chips', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha'), modelOf('beta')],
    discovery: [modelOf('alpha'), modelOf('beta'), modelOf('gamma', { name: 'Gamma' })],
  })
  const button = page.control('action.fetch')
  assert.ok(button !== undefined)
  await button.props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.urls.filter((call) => call.options?.method === 'POST').length, 1)
  // The draft carries the CURRENT form's baseURL, not a second endpoint field.
  assert.deepEqual(JSON.parse(page.calls.urls.find((call) => call.options?.method === 'POST').options.body), {
    baseURL: 'https://opencode.ai/zen/go/v1',
  })
  assert.ok(page.control('fetch.search') !== undefined, 'the picker offers a search box')
  // Checked mirrors the draft's enabled set — the dialog is a SELECTION, not an
  // "add" list. With the shipped default that set is EMPTY: a model the gateway
  // advertises is not a model the operator chose, so nothing starts checked.
  assert.equal(page.control('candidate.alpha').props.checked, false)
  assert.equal(page.control('candidate.gamma').props.checked, false, 'advertised is not the same as enabled')
  // Membership only. The list must not assert what a model can do: that is the
  // sync's job, and a claim here would come from a snapshot rather than from
  // evidence. The id and name are all a row carries.
  assert.equal(
    page.find((node) => node.props?.['data-ocg-chips'] === 'gamma').length, 0,
    'a candidate row renders no capability chips',
  )
  const row = page.find((node) => node.props?.className === 'ocg-candidate'
    || node.props?.className === 'ocg-candidate ocg-candidate--on')
  assert.ok(row.length >= 3, 'every discovered id still gets a row')
  page.restore()
})

test('应用选择 commits the whole new selection immediately — picking IS activating', async () => {
  const page = await harness({
    // Nothing is enabled on a fresh install, so the gesture is "pick one".
    catalogue: [],
    discovery: [modelOf('alpha'), modelOf('beta'), modelOf('gamma')],
  })
  await page.control('action.fetch').props.onClick()
  await drainMicrotasks()
  await page.reload()
  page.control('candidate.alpha').props.onChange() // on
  await page.reload()
  await page.control('fetch.apply').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1, 'the apply wrote immediately; no separate 保存 click')
  const ops = page.calls.mutate[0].ops
  assert.deepEqual(ops.map((op) => op.path.join('.')), [
    'models.disabled', 'models.extra', 'models.overrides', 'models.replaceDiscovered',
  ])
  // The pick lands in `extra`, which IS the enabled set in replacement mode:
  // writing `disabled` alone would activate nothing.
  const extra = ops.find((op) => op.path.join('.') === 'models.extra').value
  assert.deepEqual(extra.map((entry) => entry.id), ['alpha'])
  assert.equal(page.control('fetch.apply'), undefined, 'the dialog closed')
  assert.ok(page.control('model.alpha.toggle') !== undefined, 'the picked model is in the directory')
  assert.equal(page.control('model.beta.toggle'), undefined, 'the unpicked ones are not')
  page.restore()
})


test('a stopped model comes back through the picker: unchecked becomes checked, exclusion cleared', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha')],
    discovery: [modelOf('alpha'), modelOf('beta')],
    describe: describeAnswer({ user: { models: { disabled: ['beta'], extra: [], overrides: {}, replaceDiscovered: false } } }),
  })
  await page.control('action.fetch').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.control('candidate.beta').props.checked, false, 'a stopped model reads as unchecked, not as an "excluded" row')
  page.control('candidate.beta').props.onChange()
  await page.reload()
  await page.control('fetch.apply').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.deepEqual(page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'models.disabled').value, [])
  assert.match(page.text, /已启用 1 个并保存/u)
  page.restore()
})

test('a discovery failure is shown and the picker never opens', async () => {
  const page = await harness({ failDiscover: { ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'no value for credential reference "NOPE"' } } })
  await page.control('action.fetch').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.match(page.text, /MISSING_CREDENTIAL/u)
  assert.equal(page.control('fetch.apply'), undefined, 'no candidates, no dialog actions')
  page.restore()
})

test('诊断 renders the health rows, the log ring and the connection the host would use', async () => {
  const page = await harness({
    diagnostics: {
      ok: true,
      diagnostics: {
        kind: 'dsh-opencodego/diagnostics',
        at: 1,
        connection: { baseURL: 'http://127.0.0.1:45551/v1', apiKeyEnv: 'OCG_UNSET', legacyInlineKey: false },
        configuration: { models: { protocolOverridesShadowed: ['stale-alias'] } },
        catalogue: { status: 'stale', discovered: 3, effective: 2, sources: [{ id: 'a', source: 'endpoint' }, { id: 'hand', source: 'extra' }] },
        health: { rows: [{ modelId: 'a', category: 'ok', protocol: 'openai-completions', status: 200, action: 'none' }], unusable: [], summaryLines: ['a: ok'] },
        log: { lines: [{ at: 1, level: 'warn', message: 'endpoint unreachable' }], warnings: [{ at: 1, level: 'warn', message: 'endpoint unreachable' }] },
      },
    },
  })
  const button = page.control('action.diagnostics')
  assert.ok(button !== undefined)
  await button.props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.match(page.text, /http:\/\/127\.0\.0\.1:45551\/v1/u)
  assert.match(page.text, /凭据引用 OCG_UNSET（只是名字，不是值）/u)
  assert.match(page.text, /status=stale/u)
  assert.match(page.text, /a\(endpoint\)、hand\(extra\)/u)
  assert.match(page.text, /stale-alias/u)
  assert.match(page.text, /openai-completions/u)
  assert.match(page.text, /endpoint unreachable/u)
  assert.match(page.text, /warn 1 条/u)
  page.restore()
})

test('诊断 shows a route failure instead of a half-filled table', async () => {
  const { factory } = await loadRegistration()
  const React = fakeReact()
  const exports = factory(() => ({ default: React, ...React }))
  let Component
  let options
  const ctx = {
    remote: {
      settings: { describe: () => Promise.resolve({ ok: true, value: describeAnswer() }) },
      credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (registrationOptions, Registered) => { options = registrationOptions; Component = Registered; return () => {} },
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'forbidden', message: 'only reachable from the harness GUI origin' } }) })
  try {
    exports.apply(ctx)
    const props = { close: () => {}, ...options.inject() }
    const tree = await React.settle(Component, props)
    const button = find(tree, (node) => node.props?.['data-ocg-field'] === 'action.diagnostics')[0]
    await button.props.onClick()
    const after = await React.settle(Component, props)
    assert.match(texts(after).join('\n'), /forbidden: only reachable from the harness GUI origin/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('信息同步 asks the gateway about every enabled model, one at a time, and shows it', async () => {
  const page = await harness({
    catalogue: [modelOf('alpha'), modelOf('beta')],
    sync: (id) => (id === 'beta'
      // A model the gateway still lists and upstream no longer serves.
      ? { available: false, status: 'delisted', reason: '上游已下架：Model is unavailable.' }
      : {
          available: true,
          status: 'available',
          protocol: { chosen: 'openai-completions', verified: true },
          contextWindow: 1048576,
          maxTokens: 131072,
          input: ['text', 'image'],
          reasoning: { levels: { low: 'low', high: 'high' }, hasOff: true },
          evidence: [{ step: 'availability', status: 200 }],
        }),
  })
  const button = page.control('action.sync')
  assert.ok(button !== undefined, 'the models card offers a sync')
  assert.match(texts(button).join(' '), /信息同步/u)

  await button.props.onClick()
  await drainMicrotasks()
  await page.reload()

  // One request PER MODEL: that is what makes progress real and a stop possible
  // between models rather than only before the whole list.
  const syncCalls = page.calls.urls.filter((call) => String(call.url).includes('/opencode-go-native/sync'))
  assert.equal(syncCalls.length, 2, 'one sync request per enabled model')
  assert.deepEqual(syncCalls.map((call) => JSON.parse(call.options.body).id), ['alpha', 'beta'])

  // The verdict lands on the row's STATUS DOT, not a verdict box: green for a
  // model that answered, orange for one the gateway buried — and no box at all.
  const okDot = page.find((node) => node.props?.['data-ocg-dot'] === 'alpha')
  assert.equal(okDot.length, 1, 'the working model gets a status dot')
  assert.match(okDot[0].props.className, /ocg-dot--ok/u)
  assert.equal(page.find((node) => node.props?.['data-ocg-sync'] !== undefined).length, 0, 'no verdict box any more')

  const deadDot = page.find((node) => node.props?.['data-ocg-dot'] === 'beta')
  assert.equal(deadDot.length, 1, 'the dead model gets a status dot too')
  assert.match(deadDot[0].props.className, /ocg-dot--warn/u)
  // A dead model still says so in ONE line (no box), and names a replacement.
  const dead = page.find((node) => node.props?.['data-ocg-dead'] === 'beta')
  assert.equal(dead.length, 1)
  const deadText = texts(dead[0]).join(' ')
  assert.match(deadText, /已下架/u)
  assert.match(deadText, /Model is unavailable/u)
  // …and it points somewhere that works, instead of only complaining.
  assert.match(deadText, /建议换用 alpha/u)
  // A row that just answered the gateway must not simultaneously claim it has
  // never been asked: the verdict supersedes the "能力信息还没取过" hint.
  assert.equal(page.find((node) => node.props?.['data-ocg-unsynced'] === 'alpha').length, 0)
  assert.equal(page.find((node) => node.props?.['data-ocg-unsynced'] === 'beta').length, 0)
  page.restore()
})

test('a model that has never been synced shows NO capability chips, and says why', async () => {
  // The whole point of the sync: a declared number and a measured one look
  // identical once rendered, so nothing is rendered until something is measured.
  const page = await harness({ catalogue: [modelOf('fresh', { synced: false })] })
  assert.equal(
    page.find((node) => node.props?.['data-ocg-chips'] === 'fresh').length, 0,
    'an unsynced row must not show capability chips',
  )
  const notice = page.find((node) => node.props?.['data-ocg-unsynced'] === 'fresh')
  assert.equal(notice.length, 1, 'and it must say why it is empty')
  assert.match(texts(notice[0]).join(' '), /信息同步/u)
  // The row's dot reads red until something has been measured.
  const dot = page.find((node) => node.props?.['data-ocg-dot'] === 'fresh')
  assert.equal(dot.length, 1)
  assert.match(dot[0].props.className, /ocg-dot--bad/u)
  page.restore()
})

// ── subscriptions + balance (0.8.2) ────────────────────────────────────────

test('the subscription list shows one progress bar per window, and one click switches who pays', async () => {
  const now = Date.now()
  const page = await harness({
    describe: describeAnswer({
      user: { subscriptions: [{ id: 'work', label: '公司号' }] },
    }),
    usage: {
      ok: true,
      subs: [
        {
          id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_DEFAULT', isDefault: true, active: true, configured: true,
          usage: {
            windows: {
              rolling: { status: 'ok', percent: 12 },
              weekly: { status: 'ok', percent: 83, resetsAt: new Date(now + 3 * 3600_000).toISOString() },
            },
            checkedAt: now,
          },
        },
        {
          id: 'work', label: '公司号', apiKeyRef: 'OPENCODE_GO_WORK', isDefault: false, active: false, configured: true,
          usage: { windows: { weekly: { status: 'exhausted', percent: 100 } }, checkedAt: now },
        },
      ],
    },
  })
  await page.reload()
  assert.equal(page.control('subs.count').children[0], '2')
  assert.match(page.text, /默认/u)
  assert.match(page.text, /公司号/u)
  assert.match(page.text, /5h/u, 'the rolling meter is labelled in the short form')
  assert.match(page.text, /83%/u, 'the default row shows its weekly percent')
  assert.match(page.text, /100%/u)
  // The long window name and the reset time are phrased humanly, in the tooltip.
  assert.ok(
    page.find((node) => typeof node.props?.title === 'string' && /5 小时/.test(node.props.title)).length > 0,
    'the meter tooltip spells the window out',
  )
  assert.ok(
    page.find((node) => typeof node.props?.title === 'string' && /重置/u.test(node.props.title)).length > 0,
    'a reset time is phrased, not an ISO blob',
  )
  // The ACTIVE row is the first one; the other one is renderable but plainly
  // not the payer.
  assert.equal(page.control('subscriptions[0].activate').props['data-ocg-sub-active'], '1')
  assert.equal(page.control('subscriptions[1].activate').props['data-ocg-sub-active'], '0')
  assert.match(page.text, /当前/u)
  // ONE click switches: a settings write of its own, no 保存 needed.
  page.control('subscriptions[1].activate').props.onClick()
  await drainMicrotasks()
  assert.equal(page.calls.mutate.length, 1)
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['activeSubscription'], value: 'work' }])
  await page.reload()
  assert.equal(page.control('subscriptions[1].activate').props['data-ocg-sub-active'], '1')
  page.restore()
})

test('a subscription row is TWO lines: who pays on top, and the balance with its reset time underneath', async () => {
  const now = Date.now()
  const page = await harness({
    usage: {
      ok: true,
      subs: [{
        id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_API_KEY', isDefault: true, active: true,
        configured: true, source: 'file',
        usage: {
          windows: {
            // A window the gateway never gave a moment for: a bar, but NO reset line.
            rolling: { status: 'ok', percent: 12 },
            weekly: { status: 'ok', percent: 83, resetsAt: new Date(now + 3 * 3600_000).toISOString() },
            monthly: { status: 'ok', percent: 53, resetsAt: new Date(now + 40 * 60_000).toISOString() },
          },
          checkedAt: now,
        },
      }],
    },
  })
  const main = page.find((node) => typeof node.props?.className === 'string'
    && node.props.className.includes('ocg-sub-main'))[0]
  assert.notEqual(main, undefined, 'the row body exists')
  // The row's five children in ORDER: radio, name, 设置, 删除, then the meters. The
  // balance is a grid item of its OWN (`grid-area: 2 / 2 / 3 / -1` in the
  // stylesheet) — that is what makes it a second line instead of a fourth
  // column, and it is the point of the layout: the name stops competing with
  // three meters for width.
  const kids = main.children
  assert.equal(kids.length, 5, 'radio, name, two row actions, and the balance line')
  assert.ok(kids[0].props.className.includes('ocg-radio'), 'line 1 starts at the radio')
  assert.ok(kids[1].props.className.includes('ocg-sub-name-wrap'), 'the name carries line 1')
  assert.equal(kids[2].props['data-ocg-field'], 'subscriptions[0].toggle', 'the actions stay on the name line')
  assert.equal(kids[3].props['data-ocg-field'], 'subscriptions[0].remove')
  const group = kids[4]
  assert.equal(group.props['data-ocg-balance'], 'default', 'the last child IS the balance line')
  // Three cells, each a pill with (at most) a reset phrase under it.
  const cells = group.children
  assert.equal(cells.length, 3, 'one meter per window, always')
  for (const cell of cells) {
    assert.ok(cell.props.className.includes('ocg-meter-cell'), 'the cell wraps the pill')
    // Children flatten like the DOM appends them, so "no reset line" is simply a
    // cell with nothing under its pill.
    assert.ok(cell.children.length <= 2, 'the cell is the pill, plus at most the reset line')
    assert.ok(cell.children[0].props.className.includes('ocg-meter'))
  }
  const resetOf = (window) => cells
    .map((cell) => cell.children[1])
    .find((node) => node?.props?.['data-ocg-reset'] === window)
  // The phrase is ON THE PAGE now, not only in a tooltip — but only where the
  // gateway actually reported a moment.
  assert.equal(resetOf('rolling'), undefined, 'a window with no resetsAt gets no invented reset line')
  assert.equal(texts(resetOf('weekly')).join(''), '3 小时后')
  assert.equal(texts(resetOf('monthly')).join(''), '40 分钟后')
  assert.match(page.text, /3 小时后/u)
  assert.match(page.text, /40 分钟后/u)
  // The pill still answers "which window" in the short form, and the tooltip
  // keeps the full sentence plus the local clock moment.
  assert.equal(texts(cells[0].children[0]).join('|'), '5h|12%', 'the compact window name stays')
  const weeklyCell = cells.find((cell) => cell.props['data-ocg-window'] === 'weekly')
  assert.match(weeklyCell.props.title, /周，83%，约 3 小时后重置（\d\d-\d\d \d\d:\d\d）/u)
  // And the layout that makes the two lines true is in the served stylesheet.
  const { source } = await loadRegistration()
  assert.ok(source.includes('grid-area: 2 / 2 / 3 / -1'), 'the balance line is placed on grid row 2')
  assert.ok(/\.ocg-sub-main \{[^}]*row-gap: 6px/u.test(source), 'the row is a two-row grid')
  assert.ok(/\.ocg-meter-reset \{[^}]*text-overflow: ellipsis/u.test(source), 'a long reset phrase truncates instead of wrapping')
  page.restore()
})

test('opening the panel refreshes the balance by itself: cache first, then only what is stale', async () => {
  const page = await harness({
    describe: describeAnswer({ user: { subscriptions: [{ id: 'work', label: '公司号' }] } }),
    usage: {
      ok: true,
      subs: [{
        id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_API_KEY', isDefault: true, active: true,
        configured: true, source: 'file', usage: {},
      }],
    },
  })
  /** Every usage read the page made, in order. */
  const usageReads = () => page.calls.urls
    .map((call) => String(call.url))
    .filter((url) => url.includes('/opencode-go-native/usage'))
  // The panel paints the CACHE first (no query) and then asks the host to bring
  // the stale rows up to date — the numbers on screen are never only whatever
  // happened to be on disk when the tab opened.
  assert.equal(usageReads().length, 2, 'one cached read, then one stale-only read')
  assert.ok(!usageReads()[0].includes('refresh'), 'the cache paints first, with no refresh')
  assert.match(usageReads()[1], /\?refresh=auto$/u, 'the second ask is the stale-only mode')
  // …and it asks for that mode ONCE per mount: re-rendering the panel is not a
  // reason to talk to the gateway again.
  await page.reload()
  await drainMicrotasks()
  assert.equal(usageReads().length, 2, 'a re-render does not re-probe')
  // The BUTTON is a different act: it means "do not trust the cache", so it
  // forces every row (the host's TTL does not apply to it).
  page.control('action.refreshUsage').props.onClick()
  await drainMicrotasks()
  assert.equal(usageReads().length, 3)
  assert.match(usageReads()[2], /\?refresh=1$/u)
  // What the operator typed in a row is enough to refresh that row's balance:
  // storing a key asks the same stale-only question (a fresh reading is skipped
  // by the HOST, not by the page).
  page.control('subscriptions[0].toggle').props.onClick()
  await page.reload()
  page.control('subscriptions[0].apiKey').props.onChange({ target: { value: 'sk-NEW-not-a-real-key' } })
  page.control('subscriptions[0].apiKey').props.onBlur()
  await drainMicrotasks()
  assert.match(usageReads().at(-1), /\?refresh=auto$/u, 'a pasted key gets its balance measured')
  // Switching who pays reads the balance of the row that now pays — again
  // stale-only, so a switch cannot become a probe storm.
  page.control('subscriptions[1].activate').props.onClick()
  await drainMicrotasks()
  assert.match(usageReads().at(-1), /\?refresh=auto$/u)
  page.restore()
})

test('a new subscription needs a name, keeps a stable id, and stores its key in its own slot', async () => {
  const page = await harness()
  page.control('action.addSub').props.onClick()
  await page.reload()
  assert.notEqual(page.control('subscriptions[1].toggle'), undefined, 'the adder appended a row')
  page.control('subscriptions[1].toggle').props.onClick()
  await page.reload()
  assert.ok(page.control('subscriptions[1].label') !== undefined, 'the row has a NAME field, not an id field')
  assert.equal(page.control('subscriptions[1].id'), undefined, 'the id is never typed')
  page.control('subscriptions[1].apiKey').props.onChange({ target: { value: 'sk-NEW-not-a-real-key' } })
  await page.reload()
  // A key with no name has no derived slot: it stays staged, and the validator
  // says why instead of writing a secret nowhere.
  assert.match(page.text, /必填：这条订阅的名字/u)
  page.control('subscriptions[1].apiKey').props.onBlur()
  await drainMicrotasks()
  assert.equal(page.calls.credentialSet.length, 0, 'no slot, no write')
  assert.equal(page.calls.mutate.length, 0, 'a blank adder row is not a write either')
  // With a name, the stored entry keeps the id the row was born with, while the
  // credential slot follows the NAME.
  page.control('subscriptions[1].label').props.onChange({ target: { value: 'Work号' } })
  await page.reload()
  await settleWrites(page)
  assert.deepEqual(
    page.calls.mutate[0].ops.find((op) => op.path.join('.') === 'subscriptions').value,
    [{ id: 'sub-2', label: 'Work号' }],
  )
  // The key returns to the field's own act: leaving it now resolves the slot.
  page.control('subscriptions[1].apiKey').props.onBlur()
  await drainMicrotasks()
  assert.deepEqual(page.calls.credentialSet, [{ ref: 'OPENCODE_GO_WORK', value: 'sk-NEW-not-a-real-key' }])
  await page.reload()
  // No pending write is left behind — the form converged.
  assert.equal(page.control('write.state'), undefined, 'a settled form shows no write indicator')
  // Switching to the freshly stored row is likewise an immediate act.
  page.control('subscriptions[1].activate').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.control('subscriptions[1].activate').props['data-ocg-sub-active'], '1')
  page.restore()
})

test('the card head names the subscription that PAYS, so a switch is visible', async () => {
  const subscriptions = [{ id: 'work', label: '公司号' }]
  const page = await harness({
    describe: describeAnswer({
      value: { baseURL: 'https://opencode.ai/zen/go/v1', displayName: '默认号', activeSubscription: 'work', subscriptions },
      user: { displayName: '默认号', subscriptions },
    }),
    usage: {
      ok: true,
      subs: [
        { id: 'default', label: '默认号', isDefault: true, active: false, configured: true, usage: {} },
        { id: 'work', label: '公司号', isDefault: false, active: true, configured: true, usage: {} },
      ],
    },
  })
  await page.reload()
  // `work` pays, so the head says so — it used to show `displayName`, which is
  // only the DEFAULT row's name.
  assert.equal(page.control('active.name').children[0], '公司号')
  page.control('subscriptions[0].activate').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.control('active.name').children[0], '默认号', 'the head follows the switch')
  page.restore()
})

test('clicking the DEFAULT row switches the payer back, in one write', async () => {
  // The row the user actually clicked in the bug report: the synthesized default
  // row, which has no stored entry. The click must reach the host — a page that
  // shows 「当前」 on a row the host never heard about is the worst of both
  // worlds (it lies AND it keeps the form permanently dirty).
  const page = await harness({
    describe: describeAnswer({
      value: { baseURL: 'https://opencode.ai/zen/go/v1', activeSubscription: 'work', subscriptions: [{ id: 'work', label: '公司号' }] },
      user: { subscriptions: [{ id: 'work', label: '公司号' }] },
    }),
    usage: {
      ok: true,
      live: { liveRef: 'OPENCODE_GO_API_KEY', activeId: 'work' },
      subs: [
        { id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_DEFAULT', isDefault: true, active: false, usage: {} },
        { id: 'work', label: '公司号', apiKeyRef: 'OPENCODE_GO_WORK', isDefault: false, active: true, usage: {} },
      ],
    },
  })
  await page.reload()
  assert.equal(page.control('subscriptions[1].activate').props['data-ocg-sub-active'], '1')
  page.control('subscriptions[0].activate').props.onClick()
  await drainMicrotasks()
  await page.reload()
  assert.equal(page.calls.mutate.length, 1, 'the click writes on its own')
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['activeSubscription'], value: 'default' }])
  assert.equal(page.control('subscriptions[0].activate').props['data-ocg-sub-active'], '1')
  assert.equal(page.control('subscriptions[1].activate').props['data-ocg-sub-active'], '0')
  // And the form settled: no lingering write indicator, no hint paragraph.
  assert.equal(page.control('write.state'), undefined)
  assert.equal(page.control('action.reload'), undefined, 'the head carries no manual reload any more')
  assert.equal(page.control('subs.live'), undefined, 'the 生效变量 hint line is gone')
  assert.ok(!/生效变量/.test(page.text), 'no live-slot hint on the page')
  assert.ok(!/改动立即生效/.test(page.text), 'no auto-save hint on the page')
  page.restore()
})

test('the trash sits on every row, and the row that PAYS cannot be deleted', async () => {
  // One subscription: it is the active one, so there is nothing to remove.
  const alone = await harness()
  assert.equal(alone.control('subscriptions[0].remove').props.disabled, true, 'the only row pays, so it cannot go')
  assert.match(alone.control('subscriptions[0].remove').props.title, /当前订阅不能删除/u)
  assert.equal(alone.control('subscriptions[0].remove').props['data-ocg-remove-locked'], '1')
  alone.restore()

  // Two subscriptions: both rows carry the button, and only the ACTIVE one is
  // locked — the rule is about who pays, not about which row came first.
  const page = await harness({
    describe: describeAnswer({
      value: { baseURL: 'https://opencode.ai/zen/go/v1', subscriptions: [{ id: 'work', label: '公司号' }] },
      user: { subscriptions: [{ id: 'work', label: '公司号' }] },
    }),
    usage: {
      ok: true,
      subs: [
        { id: 'default', label: '默认', apiKeyRef: 'OPENCODE_GO_DEFAULT', isDefault: true, active: true, usage: {} },
        { id: 'work', label: '公司号', apiKeyRef: 'OPENCODE_GO_WORK', isDefault: false, active: false, usage: {} },
      ],
    },
  })
  await page.reload()
  assert.equal(page.control('subscriptions[0].remove').props.disabled, true, 'the payer is locked')
  assert.equal(page.control('subscriptions[1].remove').props.disabled, false, 'the other row is removable')
  // Removing is an act of its own too (no 保存 to press): it writes the list
  // without that row.
  page.control('subscriptions[1].remove').props.onClick()
  await settleWrites(page, 30)
  assert.equal(page.calls.mutate.length, 1, 'removing writes on its own')
  assert.deepEqual(page.calls.mutate[0].ops, [{ op: 'set', path: ['subscriptions'], value: [] }])
  page.restore()
})

test('the default row can be deleted once it stops paying, and restored from the header', async () => {
  const subscriptions = [{ id: 'work', label: '公司号' }]
  const page = await harness({
    describe: describeAnswer({
      value: {
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKeyEnv: 'OPENCODE_GO_API_KEY',
        activeSubscription: 'work',
        subscriptions,
      },
      user: { subscriptions },
    }),
  })
  await page.reload()
  // It is on the list, but not the payer: removable.
  assert.equal(page.control('subscriptions[0].remove').props.disabled, false)
  page.control('subscriptions[0].remove').props.onClick()
  await settleWrites(page, 30)
  assert.deepEqual(page.calls.mutate[0].ops, [{
    op: 'set',
    path: ['subscriptions'],
    value: [{ id: 'default', hidden: true }, { id: 'work', label: '公司号' }],
  }])
  assert.equal(page.control('subscriptions[0].remove'), undefined, 'a hidden row is not rendered at all')
  assert.notEqual(page.control('subscriptions[1].remove'), undefined, 'the other row keeps its index and its trash')
  // Reversible from the header — hiding the synthesized default is not a
  // one-way door.
  assert.notEqual(page.control('action.restoreDefaultSub'), undefined)
  page.control('action.restoreDefaultSub').props.onClick()
  await settleWrites(page, 30)
  assert.deepEqual(page.calls.mutate[1].ops, [{ op: 'set', path: ['subscriptions'], value: [{ id: 'work', label: '公司号' }] }])
  assert.notEqual(page.control('subscriptions[0].remove'), undefined, 'the default row is back on the list')
  page.restore()
})
