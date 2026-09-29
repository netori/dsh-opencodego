/**
 * dsh-opencodego — the OpenCode Go native adapter plugin.
 *
 * Registers ONE provider route, `opencode-go-native`, on `ctx.llm`, serving
 * every model the configured gateway advertises with the correct wire protocol
 * per model. The route key deliberately differs from the official
 * `opencode-go` pi-ai route so the two never collide in the adapter registry.
 *
 * Phase 2 adds: the plugin's bundled model-state file for capability prefill
 * (context/maxTokens/input modalities/reasoning levels), the npm-rule protocol
 * decision with an ordered per-model candidate chain and pre-first-chunk
 * fallback, endpoint health classification, and the learning memo that keeps a
 * refused protocol from being paid for twice. The settings page is phase 4.
 * Since 0.6.5 there are exactly TWO model sources: the gateway's `/models`
 * list (which models exist) and the plugin's own state (this file plus the
 * settings overlay — what dsh loads). Nothing is fetched from models.dev at
 * runtime.
 *
 * @module dsh-opencodego
 */

import {
  LlmError,
  resolveImageAttachmentAccess,
} from '@deepseek-ai/dsh-llm'
import { ModelCatalog } from './catalog.js'
import { OpenCodeGoAdapter } from './adapter.js'
import { catalogueModelView } from './capabilities.js'
import { createApiKeyResolver } from './credential.js'
import {
  describeTransportError,
  discover,
} from './discovery.js'
import { DIAGNOSTICS_KIND } from './diagnostics.js'
import { isTrustedApiRequest } from './http.js'
import { createLegacyKeyMigrationRunner } from './migration.js'
// `protocolChainForModel` must be IMPORTED, not merely re-exported below:
// `export { x } from './y.js'` creates no local binding, and the sync route
// needs one.
import { protocolChainForModel, resolveProtocol } from './protocol-map.js'
import { loadSnapshot } from './snapshot.js'
import { loadOfficialBaseline, officialRecordFor } from './official-baseline.js'
import { defaultOfficialCachePath, OfficialRuntime } from './official-runtime.js'
import { requestHeaders, SessionHeaderMap } from './session.js'
import { createSubRuntime } from './subruntime.js'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { defaultSyncedLayerPath, SyncedLayer } from './synced.js'
import { defaultUsageLayerPath } from './usage.js'
import { syncModel, syncedLayerFromSync } from './sync.js'
import {
  Config,
  createOptionsReader,
  DEFAULT_API_KEY_ENV,
  PKG,
  PROVIDER,
  NS,
} from './config.js'

export { OpenCodeGoAdapter } from './adapter.js'
export { ModelCatalog } from './catalog.js'
// The credential precedence, exported so a consumer (and the acceptance tools)
// can read the one decision this plugin makes about where a token comes from.
export {
  createApiKeyResolver,
  missingCredentialMessage,
  resolveConnectionApiKey,
} from './credential.js'
export { describeTransportError, discover } from './discovery.js'
export { isTrustedApiRequest, isLoopbackHostname } from './http.js'
// The one-time move of a pre-0.6.0 plain-text token into the credential store,
// exported so the acceptance tools can drive it without a live host.
export {
  createLegacyKeyMigrationRunner,
  legacyApiKeyOf,
  planLegacyApiKeyMigration,
  runLegacyApiKeyMigration,
} from './migration.js'
export {
  buildDiagnosticsView,
  DEFAULT_HEALTH_LIMIT,
  DEFAULT_LOG_LIMIT,
  DEFAULT_MODEL_ID_LIMIT,
  DIAGNOSTICS_KIND,
  healthRows,
  logLines,
} from './diagnostics.js'
export {
  claimLayersFor,
  CONFIGURABLE_INPUT_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS,
  effectiveModelIds,
  EMPTY_OVERLAY,
  MODEL_EXTRA_KEYS,
  MODEL_OVERRIDE_KEYS,
  MODEL_SET_KEYS,
  modelSource,
  normalizeModelOverlay,
  requireInputModalities,
  requireModelId,
  requirePositiveInteger,
  requireProtocol,
  requireReasoningEfforts,
} from './models.js'
export {
  ALTERNATE_PROTOCOL_HINTS,
  BUILTIN_MODEL_PROTOCOLS,
  FALLBACK_PROTOCOL,
  PROTOCOL_NPM_RULE,
  PROVIDER_NPM_DEFAULT,
  protocolChainForModel,
  protocolForModel,
  protocolForNpm,
  resolveProtocol,
} from './protocol-map.js'
export {
  chainExhaustedError,
  failureText,
  httpStatusOf,
  PROTOCOL_FAILURE,
  protocolFailureKind,
  retryableProtocolFailure,
  streamWithProtocolChain,
} from './protocol-chain.js'
export {
  DEFAULT_PROTOCOL_MEMO_TTL_MS,
  ProtocolRejectionMemo,
} from './protocol-memo.js'
export {
  catalogueModelView,
  compatFor,
  imageRequestSupport,
  modelCapabilities,
  selectableThinkingLevels,
  supportedThinkingLevels,
} from './capabilities.js'
export {
  classifyEndpointHealth,
  ENDPOINT_HEALTH,
  EndpointHealthLog,
  HEALTH_ACTION,
} from './health.js'
export {
  adaptRequestForProtocol,
} from './request-adapt.js'
// The subscription layer's decisions (0.8), exported so a consumer (and the
// acceptance tools) can pin the normalization and the active-pointer rules
// without a live host. The runtime state lives in `subruntime.js`; these are its
// host-free halves.
export {
  activeSubscriptionOf,
  CREDENTIAL_REF_PATTERN,
  DEFAULT_SUB_ID,
  DEFAULT_SUB_LABEL,
  normalizeSubscriptions,
  refForSubscriptionId,
  resolveActiveSubscription,
  SUBSCRIPTION_ENTRY_KEYS,
  SUBSCRIPTION_ID_PATTERN,
  SUBSCRIPTION_LABEL_MAX,
  USAGE_WINDOW_KEYS,
} from './subs.js'
export {
  defaultUsageLayerPath,
  parseUsageEnvelope,
  probeUsage,
  USAGE_LAYER_FILE,
  USAGE_LAYER_KIND,
  UsageLayer,
  UsageProbeCache,
} from './usage.js'
export { createSubRuntime } from './subruntime.js'
export {
  loadSnapshot,
  ModelSnapshot,
  parseSnapshot,
  SNAPSHOT_KIND,
  SNAPSHOT_URL,
  trimModelRecord,
} from './snapshot.js'
export {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_PROTOCOL_ATTEMPTS,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_SESSION_HEADER,
  DEFAULT_TRANSIENT_ATTEMPTS_PER_PROTOCOL,
  HOST_THINKING_LEVELS,
  NS,
  PKG,
  PROVIDER,
  SUPPORTED_PROTOCOLS,
  resolveOptions,
} from './config.js'

export const name = PKG

/**
 * Activate once the abstract `llm` service exists — `registerAdapter`,
 * `registerConfigurableProviders`, and `registerModelDiscovery` are all on it.
 * `credentials` is fetched lazily through `ctx.get` so the plugin still mounts
 * in a composition that has no credential plane (it then fails loud with
 * MISSING_CREDENTIAL instead of silently sending no Authorization header).
 */
export const inject = ['llm']

/**
 * The plugin entry point.
 * @param {object} ctx - the cordis context.
 * @param {import('./config.js').Config} config - the composition/settings config.
 */
export function apply(ctx, config) {
  // The facts every operation re-resolves through. `createOptionsReader` (see
  // `config.js`) re-reads the LIVE config on every call — in dsh 0.2.0 a
  // settings write commits new values INTO this config object's volatile
  // references instead of re-applying the entry, so memoizing on the object's
  // identity would answer with the load-time snapshot forever. It still hands
  // back the same resolved object while the facts are unchanged, which is what
  // the adapter's derived state is keyed on.
  //
  // The first read happens here, at load, so a structurally invalid composition
  // fails loudly rather than at the first request; a later snapshot that fails
  // beyond-schema bounds keeps the last good facts and is logged.
  let current = () => config
  const options = createOptionsReader(() => current(), {
    onInvalid: (error) => {
      ctx.logger.error(`${PKG}: keeping the last good configuration after an invalid settings snapshot`)
      ctx.logger.error(error)
    },
  })
  const initial = options()

  /**
   * Every line this plugin emits, newest last, bounded.
   *
   * The host's logger is the user-facing channel, but in this host version a
   * plugin's `ctx.logger.*` output is collected by cordis's default in-memory
   * exporter and never reaches stdout or `$DSH_HOME/web.log` (measured; see
   * PROGRESS「二期补丁」). Keeping the lines here makes an operator action
   * — the `warn` for a region/data-policy gate — independently observable
   * through the adapter registration, exactly like `health` and `memo`.
   */
  const emitted = []
  const log = (level, message) => {
    emitted.push({ at: Date.now(), level, message })
    if (emitted.length > 200) emitted.shift()
    if (level === 'info' && !initial.debug) {
      // Discovery successes are routine; keep the default log quiet and let
      // failures always surface.
      ctx.logger.debug?.(`[${PKG}] ${message}`)
      return
    }
    const write = ctx.logger[level] ?? ctx.logger.info
    write.call(ctx.logger, `[${PKG}] ${message}`)
  }

  const credentialsOf = () => ctx.get('credentials')
  // The precedence lives in `credential.js` (host-free, unit-tested); this is
  // only the wiring that hands it the live facts, with the host's own
  // `credentialRef` / `assertUsableApiKey` loaded lazily inside it.
  //
  // `onLegacy` fires whenever the token came from the pre-0.6.0 plain-text field
  // rather than the credential store, which is exactly the state the migration
  // is there to end. It is reported once per process: a warning on every request
  // would bury its own cause.
  let legacyWarned = false
  /** Per-reference resolvers for the slot reads the subscription runtime asks for by name. */
  const slotResolvers = new Map()
  const resolveApiKey = createApiKeyResolver({
    credentialsOf,
    options,
    LlmError,
    onLegacy: () => {
      if (legacyWarned) return
      legacyWarned = true
      log('warn', 'using the LEGACY plain-text "apiKey" from the settings document; it should have been migrated '
        + `into the credential reference "${options().apiKeyEnv}" — check the migration warning in this log`)
    },
  })

  // The plugin's BUNDLED model-state file (`data/opencode-go.models.json`).
  // Two data sources and no more (the design notes §2.6, revised at the user's
  // insistence): ① the gateway's `/models` list decides WHICH models exist,
  // ② this in-package state file plus the settings overlay decides what dsh
  // loads for each. The file was seeded once from the opencode catalog and is
  // refreshed only by the deliberate `npm run models:fetch` — the runtime NEVER
  // fetches models.dev or any other third party. A missing or malformed file
  // leaves prefill off and is reported loudly, but never takes the route down.
  const snapshotResult = loadSnapshot()
  if (!snapshotResult.ok) {
    ctx.logger.warn(`[${PKG}] model-state file unavailable, falling back to conservative defaults: ${snapshotResult.error}`)
  } else if (initial.debug) {
    ctx.logger.info(`[${PKG}] model-state file: ${snapshotResult.snapshot.size} models, synced ${snapshotResult.snapshot.fetchedAt}`)
  }

  // The OFFICIAL capability baseline (`data/opencode-go.official.json`): what
  // each model's own authoring provider declares. It is the RELEASE-TIME
  // snapshot of models.dev — the offline floor — and since 0.9.0 the runtime
  // layer below reads the same files live for whatever the bundle cannot answer
  // for. It supplies context/output/modalities, and the contract a sync tests.
  const officialResult = loadOfficialBaseline()
  if (!officialResult.ok) {
    ctx.logger.warn(`[${PKG}] official capability baseline unavailable, sync will have nothing to test: ${officialResult.error}`)
  } else if (initial.debug) {
    ctx.logger.info(`[${PKG}] official baseline: ${officialResult.baseline.modelCount} models from models.dev @${officialResult.baseline.source?.commit ?? '?'}`)
  }

  // The RUNTIME official layer (0.9.0): the same models.dev declarations, read
  // live for the ids the bundle does not know, and re-read on a TTL for the ones
  // it does. It writes into the ONE document every consumer already reads
  // (`officialRecordFor` → `ModelCatalog#snapshotEntryFor` →
  // `composeEntryFaces`), so nothing downstream needs a second case and the
  // operator's `models.overrides` still wins over both layers.
  //
  // The document is a COPY: the bundled file's parsed object is shared with
  // nothing else, and `modelCount` is kept honest as records arrive.
  const officialRuntime = OfficialRuntime.load({
    document: officialResult.ok
      ? { ...officialResult.baseline, models: { ...officialResult.baseline.models } }
      : undefined,
    options,
    base: initial.officialBaseUrl,
    ttlMs: initial.officialSyncTtlMs,
    timeoutMs: initial.officialSyncTimeoutMs,
    path: defaultOfficialCachePath(),
    log,
  })
  if (officialRuntime.loadError !== undefined) {
    ctx.logger.warn(`[${PKG}] runtime official cache unusable, starting from the bundled baseline: ${officialRuntime.loadError}`)
  }
  if (!initial.snapshotEnabled) {
    ctx.logger.info(`[${PKG}] snapshot face off: neither the bundled baseline nor the models.dev runtime layer is consulted`)
  } else if (!initial.officialSync) {
    ctx.logger.info(`[${PKG}] officialSync off: declared numbers come from the bundled baseline only`)
  }
  /** The one declaration document the catalogue, the sync route and the adapter read. */
  const official = officialRuntime.document

  // The SYNCED layer (`$DSH_HOME/opencode-go.synced.json`): what a sync actually
  // measured on THIS account. It overlays the bundled snapshot and sits under
  // `models.overrides`, so an operator's correction still wins over a
  // measurement. Absent or corrupt means "nothing measured yet", never a fault.
  const syncedPath = defaultSyncedLayerPath()
  const synced = SyncedLayer.load(syncedPath)

  // The relay's routing header for sync probes. A sync is not a conversation, so
  // it mints (and reuses) one opaque value rather than borrowing a session id.
  const syncSessions = new SessionHeaderMap(initial.sessionHeaderMode)

  // The SUBSCRIPTION runtime (0.8): N OpenCode Go keys behind this ONE route, of
  // which exactly ONE is active. What is shared: the model list, the protocol
  // rules, the synced capability layer — all gateway facts, asked through the
  // active key. What is per-subscription: its OWN credential slot (named after
  // the subscription, e.g. `OPENCODE_GO_ME_EXAMPLE_COM`), and the balance
  // `GET {base}/usage` reports for that key
  // (measured fact: `scripts/probe-quota.mjs`). Switching is a settings write, not
  // a rotation: `activeSubscription` decides, `adapter#stream` resolves exactly
  // that one key per request, and the runtime MIRRORS it into the one live slot
  // (`apiKeyEnv`) so a single visible variable always holds the selected key.
  //
  // The two credential seams the runtime cannot own itself are injected here:
  // a per-reference READ (folded to `undefined` on a miss) and a per-reference
  // WRITE (the mirror). Both go through the host's own `credentialRef` /
  // `assertUsableApiKey`, through `credential.js`, so there is no second
  // precedence rule and no second spelling of a slot name.
  const resolveSlot = (reference) => {
    let resolver = slotResolvers.get(reference)
    if (resolver === undefined) {
      // The LEGACY inline token only ever rides the LIVE slot: it predates
      // subscriptions, and a per-row slot has exactly one supported source, the
      // store. `options()` is read per call, so a rotated value is picked up
      // without rebuilding this closure.
      resolver = createApiKeyResolver({
        credentialsOf,
        options: () => ({
          apiKeyEnv: reference,
          apiKey: reference === options().apiKeyEnv ? options().apiKey : undefined,
        }),
        LlmError,
        onLegacy: () => {
          if (legacyWarned) return
          legacyWarned = true
          log('warn', 'using the LEGACY plain-text "apiKey" from the settings document; it should have been '
            + `migrated into the credential reference "${reference}" — check the migration warning in this log`)
        },
      })
      slotResolvers.set(reference, resolver)
    }
    return resolver()
  }
  const subs = createSubRuntime({
    options,
    log,
    LlmError,
    usageLayerPath: defaultUsageLayerPath,
    fetchImpl: (url, init) => fetch(url, init),
    createKeyResolver: (sub) => createApiKeyResolver({
      credentialsOf,
      // The subscription's OWN credential slot, named after the subscription.
      // The legacy inline token only ever rides the `default` subscription (it
      // predates them), so a second key has exactly one supported source, the store.
      options: () => ({
        apiKey: sub.isDefault === true ? options().apiKey : undefined,
        apiKeyEnv: sub.apiKeyRef,
      }),
      LlmError,
      onLegacy: () => {
        if (legacyWarned) return
        legacyWarned = true
        log('warn', 'using the LEGACY plain-text "apiKey" from the settings document; it should have been migrated '
          + `into the credential reference "${sub.apiKeyRef}" — check the migration warning in this log`)
      },
    }),
    // Read ONE slot by name for the live-slot mirror and the default row's
    // upgrade. A miss is `undefined` here (it is a normal state: the row simply
    // stores nothing), while every other refusal still propagates.
    resolveCredential: async (reference) => {
      try {
        return await resolveSlot(reference)
      } catch (error) {
        if (error?.code === 'MISSING_CREDENTIAL') return undefined
        throw error
      }
    },
    // Write ONE slot: this is the "assign OPENCODE_WHOISZZJ_OUTLOOK to
    // OPENCODE_GO_API_KEY" act, performed on the host because a browser can
    // never read a secret back to copy it. The host's own provider decides
    // whether the write is allowed (a launch-environment value is read-only and
    // refuses), and a refusal is the runtime's to log, not to hide.
    setCredential: async (reference, value) => {
      const credentials = credentialsOf()
      if (credentials === undefined) {
        throw new Error('the credentials service is unavailable, so the active key cannot be mirrored into the live slot')
      }
      const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
      await credentials.set(credentialRef(reference), value)
    },
    // Presence-only credential facts for the settings rows ("this row has no key
    // stored"). Never a value: `describe` has no slot one could ride in.
    describeCredential: async (reference) => {
      const credentials = credentialsOf()
      if (credentials === undefined) return undefined
      try {
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        return await credentials.describe(credentialRef(reference))
      } catch {
        return undefined
      }
    },
    // The usage probe is a provider request: attribution rides, merged with the
    // session header, and the merge happens HERE (the call site the static guard
    // pins; `usage.js` receives this thunk, never an expanded object —
    // invariant #4's failure mode is exactly that).
    baseHeaders: (sub) => {
      const facts = options()
      return requestHeaders(
        attributionHeaders(),
        facts.sessionHeader,
        syncSessions.valueFor(`usage:${sub.id}`, facts.sessionHeaderMode),
      )
    },
  })
  // Every gateway-facing reader (discovery, the catalogue refresh, the sync
  // probes) asks the runtime for the ACTIVE key: one route, one payer — the same
  // key a chat request would spend.
  const activeKey = () => subs.activeKey()

  const catalog = new ModelCatalog({
    options,
    resolveApiKey: activeKey,
    log,
    snapshot: snapshotResult.ok ? snapshotResult.snapshot : undefined,
    synced,
    // The official baseline's DECLARED numbers (context/output/modalities) join
    // every entry at the catalog's single merge point; without this hook the
    // baseline fed only the sync route and every model ran on conservative
    // defaults (the 200K bug). The document is the MERGED one: bundled records
    // plus everything the runtime layer has fetched into it.
    official,
    // The runtime layer's own seam: `refresh` asks it for the declarations of
    // the ids no face answers for (awaited, budgeted) and for a background
    // re-read of the stale ones.
    officialRuntime,
    officialNameFor: (id) => officialRuntime.nameFor(id),
  })
  const adapter = new OpenCodeGoAdapter({
    provider: PROVIDER,
    options,
    resolveApiKey,
    // 0.8: the subscription runtime decides who pays; the plain
    // `resolveApiKey` above stays the fallback for a programmatic construction
    // that has no runtime at all.
    subs,
    catalog,
    officialRuntime,
    log,
    // Images are read through the host's own seams, exactly as the official
    // `dsh-llm-pi-ai` adapter does: the attachment service is resolved lazily
    // (it may activate after this plugin) and an image reference is bridged into
    // the current tool execution world through the fs provider.
    // The same ring the plugin's `log` writes to, so a diagnostic surface can
    // read what was said without depending on the host logger's sink.
    logged: emitted,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    // Initial value policy, and only that: the adapter re-reads
    // `sessionHeaderMode` from the resolved connection facts on every request
    // (a settings change therefore takes effect on the next request), while the
    // value map inside the adapter keeps each conversation's relay affinity
    // stable across unrelated changes. See the design notes §2.4.2.
    sessionMode: initial.sessionHeaderMode,
  })

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'OpenCode Go (native)',
    settingsNs: NS,
    settingsPath: [],
    // Configuration alone activates this route: the adapter ships no built-in
    // knowledge of a particular gateway deployment.
    declared: true,
  }])

  ctx.llm.registerAdapter([PROVIDER], adapter)

  // The settings namespace this plugin owns answers "fetch models" by
  // interrogating the gateway's /models. The runtime passes caller
  // cancellation as a separate signal.
  ctx.llm.registerModelDiscovery(NS, (request, signal) => discover({ options, resolveApiKey: activeKey }, request, signal))

  /**
   * The wire shape one model takes on this plugin's own HTTP surface.
   *
   * `catalogueModelView` is host-free and unit-tested; this closure is only the
   * wiring that hands it the live catalogue (`snapshotEntryFor` /
   * `snapshotNpmFor`), the current connection facts, and the SAME
   * `resolveProtocol` the request path uses — so the picker cannot offer a
   * different wire protocol than the adapter would dispatch.
   *
   * @param {{ id: string, name: string }} model - one catalogue entry.
   * @returns {object} the JSON-serializable description.
   */
  const describeModel = (model) => ({
    ...catalogueModelView({
      model,
      entry: catalog.snapshotEntryFor(model.id),
      snapshotNpm: catalog.snapshotNpmFor(model.id),
      connection: options(),
      resolveProtocol,
    }),
    // Whether a capability sync has ever been taken for this id. The page uses
    // it to decide whether it may show capability facts at all: before a sync
    // there is nothing measured to show, and showing the bundled snapshot's
    // numbers as if they were established is exactly the guess this plugin is
    // supposed to stop making.
    synced: synced.has(model.id),
    // The stored verdict's status, so the page's row dot can tell "synced and
    // usable" from "synced but dead" without re-asking the gateway. Undefined
    // when nothing has been synced — the `synced` flag already says that.
    syncedStatus: typeof synced.entryFor(model.id)?.status === 'string'
      ? synced.entryFor(model.id).status
      : undefined,
  })

  // Optional settings section. Absent the `settings` service the composition
  // config is the only source, which is the phase-1 shape.
  //
  // The registration is also where a pre-0.6.0 plain-text `apiKey` is retired:
  // the section is the only layer that carries it, so the migration runs once
  // the settings service (and, for the credential write, the credentials
  // service) is up. It never blocks activation and never throws into the
  // composition — a refused migration leaves the token where it was and says so.
  /**
   * Move one pre-0.6.0 plain-text token into the credential store, once.
   *
   * The order/re-entry/deferral rules live in `migration.js` (host-free, tested);
   * this is only the wiring that hands it the live service lookup and the
   * current resolved reference.
   */
  const runLegacyMigration = createLegacyKeyMigrationRunner({
    getService: (name) => ctx.get(name),
    options,
    defaultReference: DEFAULT_API_KEY_ENV,
    credentialRefOf: async () => (await import('@deepseek-ai/dsh-credentials')).credentialRef,
    ns: NS,
    log,
  })

  // The settings surface (dsh 0.1.7 model). There is no section to install and
  // no live source to adopt any more: the host projects THIS entry's Config
  // schema — its `volatile()` fields, see `config.js` — into the descriptor the
  // page reads and a write lands in the active profile patch. `apply` does NOT
  // run again for such a write: the loader commits the new values into the
  // volatile references of the config object this call was handed (0.2.0,
  // `Entry#_commitVolatile`) and emits `loader/volatile-update`. So `current`
  // stays `() => config`, but the READING of it must be live — that is
  // `createOptionsReader`, and it is the difference between "the page shows a
  // subscription" and "the host has one".
  //
  // What is left for the plugin to declare is the page policy — it ships its own
  // page, so the shell must not auto-generate a second one — plus the two pieces
  // of work a settings write used to trigger through the removed `onChange`
  // hook: the legacy key migration and the live-slot mirror. Both are cheap and
  // idempotent, so they also run here at load; the mirror additionally runs on
  // every `/usage` read, which is the moment a switch must have landed by.
  ctx.inject(['settings'], (settingsCtx) => {
    ctx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    void runLegacyMigration()
    // A subscription switch is a settings write, so this is where the ONE live
    // slot is pointed at the newly active subscription — before any request
    // asks.
    void subs.reconcile().catch((error) => {
      log('warn', `could not reconcile the live credential slot: ${errorMessage(error)}`)
    })
  })
  ctx.inject(['credentials'], () => {
    void runLegacyMigration()
    void subs.reconcile().catch((error) => {
      log('warn', `could not reconcile the live credential slot: ${errorMessage(error)}`)
    })
  })

  /**
   * The HOST's own view of this entry's settings surface.
   *
   * The page's "设置里没有命名空间 opencode-go-native" is only the browser-side
   * reading of a descriptor that did not list this entry — and every reason for
   * that is host-side: this composition has no `settings` service, the entry's
   * fiber is not active, or its Config schema cannot be projected into a form
   * (`describe()` SKIPS an entry whose schema has no volatile field — that is
   * the contract `config.js` and `tests/volatile-contract.test.mjs` hold).
   * Reported through the diagnostics route so the answer is one GET away
   * instead of one guess away; it reads, and never writes.
   *
   * @returns {object} descriptor facts, never a throw.
   */
  const settingsProbe = () => {
    const service = ctx.get('settings')
    const runtime = ctx.fiber?.runtime
    const schema = runtime?.Config
    const facts = {
      ns: NS,
      service: service === undefined ? 'missing' : 'present',
      fiberState: ctx.fiber?.state,
      // `undefined` here is the whole failure mode: the host's `describe()`
      // reads the schema off the entry's runtime, so no schema = no namespace.
      // It is normally lost by the DEFAULT export omitting `Config` (see the
      // note on `export default` at the bottom of this file).
      runtimeConfig: schema === undefined ? 'undefined' : typeof schema,
      hasToJson: schema !== undefined && 'toJSON' in schema,
    }
    if (service === undefined) return facts
    try {
      const namespaces = service.describe().map((view) => view.ns)
      return { ...facts, listed: namespaces.includes(NS), namespaces }
    } catch (error) {
      return { ...facts, described: `failed: ${errorMessage(error)}` }
    }
  }

  // ── read-only HTTP surface for the phase-4b settings page ────────────────
  // The page is a browser half, so it cannot import the host module: it needs a
  // transport. One prefix route carries both facts a settings page needs and
  // nothing else:
  //
  //   GET  /opencode-go-native/diagnostics  the payload `buildDiagnosticsView`
  //                                         composes (log ring + health + the
  //                                         model set actually in effect)
  //   GET  /opencode-go-native/models       the effective catalogue as the route
  //                                         serves it (`?refresh=1` re-discovers)
  //   POST /opencode-go-native/models       one discovery DRAFT, the same seam
  //                                         `ctx.llm.registerModelDiscovery`
  //                                         answers, with its own one-shot key;
  //                                         the reply never echoes the key
  //
  // Deliberately NARROW: this writes no settings and no credential. The one
  // thing it does write is the synced capability layer (a measurement about
  // this account, in the harness home), because a sync whose result vanished on
  // refresh would have to be re-run. The fence below is the same browser-trust
  // fence the `/api` gateway applies.
  ctx.inject(['webServer'], (webCtx) => {
    const trusted = webCtx.webServer.host === '0.0.0.0'
      ? [webCtx.webServer.host]
      : []
    ctx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/opencode-go-native',
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
              .replace(/\/+$/u, '')
        const route = `${method} ${pathname}`
        const send = (status, payload) => {
          const body = `${JSON.stringify(payload, undefined, 2)}\n`
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          })
          res.end(body)
        }
        const httpError = (status, code, message, details) => send(status, {
          ok: false,
          error: { code, message, ...details === undefined ? {} : { details } },
        })
        if (!isTrustedApiRequest(req, trusted)) {
          httpError(403, 'forbidden', `${PKG}: this route is only reachable from the harness GUI origin`)
          return
        }
        if (route === 'GET /opencode-go-native/diagnostics') {
          // `settings` rides along because it answers the one failure the page
          // cannot explain by itself: "设置里没有命名空间 opencode-go-native" is
          // the browser-side reading of "the host's descriptor did not list this
          // entry", and the reasons (no `settings` service, entry not active, a
          // Config schema the host cannot project into a form) are all HOST-side
          // facts. Read-only, same fence as the rest of this route.
          send(200, { ok: true, diagnostics: { ...adapter.diagnostics(), settings: settingsProbe() } })
          return
        }
        if (route === 'GET /opencode-go-native/models') {
          const query = new URL(req.url ?? '/', 'http://dsh.internal').searchParams
          const force = query.get('refresh') === '1'
          // The page must render the EFFECTIVE list even on a cold start (a
          // plugin whose startup sync raced the credential plane used to show
          // an empty directory until someone pressed a refresh button).
          // `refresh` is TTL-governed unless the caller forces it, and a failed
          // discovery keeps serving whatever the catalog holds.
          let refreshError
          try {
            await catalog.refresh({ force })
          } catch (error) {
            refreshError = errorMessage(error)
          }
          const effective = catalog.effectiveModels()
          // The synced layer follows the model set: a measurement for a model
          // that is no longer enabled is stale by definition, and leaving it
          // behind means removing a model and adding it back shows the old
          // verdict as if it had just been taken. `prune` refuses an empty set,
          // so a settings read that failed cannot wipe every measurement.
          const dropped = synced.prune(effective.map((model) => model.id))
          if (dropped.length > 0) {
            synced.save()
            log('info', `dropped ${dropped.length} stale synced measurement(s): ${dropped.join(', ')}`)
          }
          send(200, {
            ok: true,
            source: force ? 'endpoint' : 'cache',
            ...refreshError === undefined ? {} : { refreshError },
            models: effective.map((model) => describeModel(model)),
          })
          return
        }
        if (route === 'GET /opencode-go-native/sync') {
          send(200, {
            ok: true,
            path: synced.path,
            models: synced.toDocument().models,
          })
          return
        }
        // The SUBSCRIPTION face (0.8): one row per configured key — the label,
        // the credential slot, which one is ACTIVE, whether a key is stored, and
        // the last-known `/usage` balance. `?refresh=1` probes every
        // subscription back-to-back and `?refresh=auto` probes only the ones
        // whose last good reading is older than `usagePollTtlMs` — that is what
        // the page asks for when the panel OPENS, so opening a panel costs a
        // request only when the numbers on screen are actually stale. Probes are
        // bounded per probe and never in parallel: the requests ride the same
        // gateway. Nothing here writes settings; the rows carry reference NAMES,
        // never values.
        if (route === 'GET /opencode-go-native/usage') {
          const query = new URL(req.url ?? '/', 'http://dsh.internal').searchParams
          const refresh = query.get('refresh')
          let refreshError
          let rows
          // A page read is the cheapest moment to make the live slot agree with
          // the pointer: it is synchronous with what the operator is looking at,
          // and it cannot fail the read (`reconcile` never throws for a refused
          // mirror — it records it in `projection()`).
          try {
            await subs.reconcile()
          } catch (error) {
            refreshError = errorMessage(error)
          }
          try {
            rows = refresh === '1' ? await subs.refreshAll()
              : refresh === 'auto' ? await subs.refreshStale()
                : await subs.view()
          } catch (error) {
            refreshError = errorMessage(error)
            rows = await subs.view().catch(() => subs.rows())
          }
          send(200, {
            ok: true,
            // The live slot's name and what the mirror last did: the page says
            // "the active key is mirrored into <slot>" only when that is true.
            live: subs.projection(),
            ...(refreshError === undefined ? {} : { refreshError }),
            subs: rows,
          })
          return
        }
        if (route === 'POST /opencode-go-native/sync') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            httpError(400, 'bad-request', `${PKG}: the request body must be a JSON object`)
            return
          }
          const modelId = typeof body.id === 'string' ? body.id.trim() : ''
          if (modelId.length === 0) {
            httpError(400, 'bad-request', `${PKG}: "id" must be a non-empty model id`)
            return
          }
          // A page that navigates away, or that presses 停止, closes the
          // request. Aborting here stops us spending gateway requests on a run
          // nobody is waiting for; the per-request ceiling covers the other way
          // a sync could stall (a gateway that simply never answers).
          const controller = new AbortController()
          const onClose = () => controller.abort('client went away')
          req.on?.('close', onClose)
          try {
            const facts = options()
            const apiKey = await activeKey()
            const snapshotNpm = catalog.snapshotNpmFor(modelId)
            const protocol = resolveProtocol(modelId, {
              overrides: facts.protocolOverrides,
              snapshotNpm,
            })
            // A sync is the SECOND moment the declaration face is completed
            // (the catalogue refresh is the first): a model nobody has listed
            // yet still gets its official contract before it is probed, so the
            // sync tests the real contract instead of falling back to the whole
            // ladder. Best-effort by contract — a failed fetch leaves the
            // bundled record (or none) exactly as it was.
            if (facts.snapshotEnabled && facts.officialSync) {
              await officialRuntime.ensure(modelId).catch(() => 'failed')
            }
            const officialRecord = officialRecordFor(official, modelId)
            const sessionValue = syncSessions.valueFor(body.sessionId, facts.sessionHeaderMode)
            const result = await syncModel({
              id: modelId,
              baseURL: facts.baseURL,
              apiKey,
              fetchImpl: (...args) => fetch(...args),
              // Attribution is mandatory on every provider request and the
              // session header is the relay's own routing requirement, so they
              // are merged the same way the request path merges them — through
              // `requestHeaders(attribution(), ...)`, never instead of it.
              baseHeaders: () => requestHeaders(attributionHeaders(), facts.sessionHeader, sessionValue),
              protocol,
              signal: controller.signal,
              // OpenCode's recommendation first; the rest of the chain only if
              // that recommendation turns out not to answer.
              alternates: (id, primary) => protocolChainForModel(id, {
                overrides: facts.protocolOverrides,
                snapshotNpm,
                maxAttempts: 3,
              }).filter((candidate) => candidate !== primary),
              official: officialRecord,
            })
            // Persist BEFORE answering: a reply the page cannot re-read after a
            // refresh would be a measurement the user has to re-take.
            synced.put(syncedLayerFromSync(result))
            const saved = synced.save()
            send(200, { ok: true, sync: result, saved: saved ?? null })
          } catch (error) {
            httpError(200, error?.code ?? 'SYNC_FAILED', errorMessage(error))
          } finally {
            req.off?.('close', onClose)
          }
          return
        }
        if (route === 'POST /opencode-go-native/models') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            httpError(400, 'bad-request', `${PKG}: the request body must be a JSON object`)
            return
          }
          if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
            httpError(400, 'bad-request', `${PKG}: "apiKey" must be a string when present`)
            return
          }
          if (body.baseURL !== undefined && typeof body.baseURL !== 'string') {
            httpError(400, 'bad-request', `${PKG}: "baseURL" must be a string when present`)
            return
          }
          try {
            const models = await discover({ options, resolveApiKey: activeKey }, body)
            // Same description as the catalogue route, so a candidate the picker
            // shows carries the plugin's model state — the operator picks an
            // id, not a set of numbers.
            send(200, {
              ok: true,
              models: models.map((model) => describeModel(model)),
            })
          } catch (error) {
            httpError(200, error?.code ?? 'DISCOVERY_FAILED', errorMessage(error))
          }
          return
        }
        httpError(404, 'not-found', `${PKG}: no such route (${route})`)
      },
    }), 'dsh-opencodego: /opencode-go-native diagnostics route')
  })

  // Startup sync is OPT-IN since 0.6.8 (`sync: true` in the document): every consumer
  // refreshes on demand (the page's GET route, adapter.listModels, the first request),
  // so the boot fetch only pre-warms. It still waits for the credential plane: a `dsh web`
  // boot activates plugins and services asynchronously, so a refresh issued the
  // moment this plugin loads can run before credentials resolve and log a
  // spurious `MISSING_CREDENTIAL` (measured — the plugin's own log ring showed
  // exactly that). Discovery is still failure-tolerant either way: the route
  // stays registered, the last successful list keeps serving, and an on-demand
  // refresh retries.
  //
  // An inline `apiKey` (pre-0.6.0 document, mid-migration) needs no credentials
  // plane at all: the key is already in the resolved snapshot, so the sync is
  // not gated on a service that composition may not have. Every other
  // composition waits for the credential plane (see the note above).
  const startSync = () => {
    void catalog.refresh().then((models) => {
      if (!initial.debug) return
      log('info', `startup sync: ${models.length} models`)
      for (const line of adapter.health.summaryLines()) log('info', `endpoint health: ${line}`)
    }).catch((error) => {
      log('warn', `startup sync failed: ${describeTransportError(error)}`)
    })
  }
  if (initial.sync) {
    if (initial.apiKey !== undefined) startSync()
    else {
      ctx.inject(['credentials'], (credentialsCtx) => {
        if (credentialsCtx.get('credentials') === undefined) return
        startSync()
      })
    }
  }

  ctx.logger.info(
    `[${PKG}] route "${PROVIDER}" registered against ${initial.baseURL} `
    + `(live credential slot "${initial.apiKeyEnv}"${initial.apiKey === undefined ? '' : ' + a LEGACY plain-text "apiKey" still in the settings document (value never logged)'}, `
    + `subscriptions: ${String(initial.subscriptions.length)} (${initial.subscriptions.map((sub) => sub.id).join(', ')}; active "${initial.activeSubscription}", `
    + `slots ${initial.subscriptions.map((sub) => sub.apiKeyRef).join(', ')}), `
    + `sync ${initial.sync ? 'on' : 'off'}, `
    + `snapshot ${initial.snapshotEnabled && snapshotResult.ok ? 'on' : 'off'}, `
    + `protocol fallback ${initial.protocolFallback ? `on (max ${initial.maxProtocolAttempts} candidates)` : 'off'}, `
    + `models: ${initial.models.disabled.length} disabled, ${Object.keys(initial.models.extra).length} extra, `
    + `${Object.keys(initial.models.overrides).length} overridden)`,
  )
}

/** The one-line text of any thrown value. */
function errorMessage(error) {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error && cause.message.length > 0) return `${error.message}: ${cause.message}`
    return error.message
  }
  return String(error)
}

/**
 * Read one JSON request body, refusing anything but a plain object.
 *
 * A body larger than the cap is refused before it is buffered, and a malformed
 * body is refused with the parse error named: the discovery route carries a
 * credential, so "the request was unclear" is not an acceptable answer.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum accepted body size in bytes.
 * @returns {Promise<object | undefined>} the parsed object, or `undefined` when unusable.
 */
async function readJsonBody(req, limit = 65_536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The cordis plugin object, in the shape the LOADER actually consumes.
 *
 * `@deepseek-ai/cordis-plugin-loader#unwrapExports` PREFERS `default` over the
 * module namespace (`exports.default ?? exports`), and the registry builds the
 * plugin's runtime from whatever object that returns
 * (`runtime = { name, callback, fibers, Config: plugin.Config }`). So a default
 * export that omits `Config` costs the entry its SCHEMA, not merely a
 * convenience: `@deepseek-ai/dsh-settings#schema` reads
 * `entry.fiber.runtime.Config`, and `describe()` SKIPS an entry without one.
 * The plugin still loads, still applies, still serves every route — and its
 * settings namespace silently does not exist, which the page reports as
 * 「设置里没有命名空间 opencode-go-native」. `tests/loader-contract.test.mjs`
 * unwraps the built module this same way and pins the fields.
 */
export default { name, inject, Config, apply }
