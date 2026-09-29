/**
 * Configuration vocabulary SHARED by the two halves of this plugin.
 *
 * The browser half cannot import the host half: it is served as a standalone
 * bundle to the page and has no access to `node_modules` (see
 * `scripts/build-client.mjs`). The vocabulary below is therefore written once
 * and **inlined into both bundles by each build**, and `tests/vocabulary.test.mjs`
 * asserts the inlined client copy is deep-equal to the host's
 * (`src/models.js` / `src/vocab.js`) — a drift guard rather than two sources of
 * truth.
 *
 * Keep this module free of host imports: the bundler resolves its relative
 * imports and nothing else.
 *
 * @module dsh-opencodego/client/vocab
 */

/** The settings namespace this plugin owns (mirrors `src/config.js#NS`). */
export const SETTINGS_NS = 'opencode-go-native'

/** The `models` block's own keys (mirrors `src/models.js#MODEL_SET_KEYS`). */
export const MODEL_SET_KEYS = ['disabled', 'extra', 'overrides', 'replaceDiscovered']

/** Keys accepted in one `models.extra[]` entry (mirrors `MODEL_EXTRA_KEYS`). */
export const MODEL_EXTRA_KEYS = [
  'id', 'name', 'api', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts',
]

/** Keys accepted in one `models.overrides[id]` entry (mirrors `MODEL_OVERRIDE_KEYS`). */
export const MODEL_OVERRIDE_KEYS = ['api', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts']

/** Input modalities a configuration may name (mirrors `CONFIGURABLE_INPUT_MODALITIES`). */
export const CONFIGURABLE_INPUT_MODALITIES = ['text', 'image']

/** Thinking levels a configuration may name (mirrors `CONFIGURABLE_THINKING_LEVELS`, i.e. host levels minus `off`). */
export const CONFIGURABLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Wire protocols this build can dispatch (mirrors `SUPPORTED_PROTOCOLS`). */
export const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** Session-header value policies (mirrors `SESSION_HEADER_MODES`). */
export const SESSION_HEADER_MODES = ['session-id', 'uuid']

/**
 * The subscription layer (0.8), mirroring `src/subs.js` — the drift guard in
 * `tests/vocabulary.test.mjs` pins these against the host's exports.
 *
 * A subscription is a NAME and a KEY. Exactly one is active at a time. Each row
 * stores its key in its OWN slot, named after the row (`me@example.com` →
 * `OPENCODE_GO_ME_EXAMPLE_COM`) by `logic.js#subscriptionSlotOf`, which
 * mirrors the host's derivation. The host then mirrors the ACTIVE row's value
 * into the one LIVE slot (the top-level `apiKeyEnv`), which is what makes
 * "selecting a row switches the single API-key variable" true.
 */

/** The reserved id of the implicit default subscription (mirrors `DEFAULT_SUB_ID`). */
export const DEFAULT_SUB_ID = 'default'

/** What the default row is called when nothing names it (mirrors `DEFAULT_SUB_LABEL`). */
export const DEFAULT_SUB_LABEL = '默认'

/** The quota windows the gateway reports, in display order (mirrors `USAGE_WINDOW_KEYS`). */
export const USAGE_WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

/** Chinese labels for the usage windows, as the balance meters show them. */
export const USAGE_WINDOW_LABELS = { rolling: '5 小时', weekly: '周', monthly: '月' }

/** The one-or-two-character form the meter pill shows, so three windows fit the balance line. */
export const USAGE_WINDOW_SHORT = { rolling: '5h', weekly: '周', monthly: '月' }

/** Keys accepted in one `subscriptions[]` entry (mirrors `SUBSCRIPTION_ENTRY_KEYS`). */
export const SUBSCRIPTION_ENTRY_KEYS = ['id', 'label', 'hidden']

/** A subscription id must match this (mirrors `SUBSCRIPTION_ID_PATTERN`). */
export const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/** A credential slot name must match this (mirrors `CREDENTIAL_REF_PATTERN`). */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Copy for the subscription list — the top of the page.
 *
 * The page shows ONE short line and keeps the full explanation in the tooltip: a
 * settings page that opens with a paragraph is a page nobody reads.
 */
export const SUBS_TITLE = '订阅'
export const SUBS_NOTE = '点一行即用它；同一时刻只有一条生效。'
export const SUBS_DESCRIPTION =
  '每条订阅是一把 OpenCode Go 密钥：一个名字 + 一个 API key，key 存在以名字命名的凭据槽位里。'
  + '同一时刻只有一条生效，点哪一行就切到哪一行——对话、获取模型、信息同步都用它。'
  + '切换时插件会把这条的 key 复制到唯一的生效变量（apiKeyEnv）上，所以「一个变量 + UI 切换」是字面成立的。'
  + '改动立即生效，不需要保存。右边的三根进度条是网关按 key 回答的余额：5 小时滚动 / 周 / 月。'
export const SUBS_ADD_BUTTON = '添加订阅'
export const SUBS_ADD_HINT = '新订阅填名字和 API 密钥即可。'
export const SUBS_REFRESH_BUTTON = '刷新余额'
export const SUBS_REFRESH_BUSY = '查询中…'
export const SUBS_NEVER_PROBED = '余额未测'
export const SUBS_ACTIVE_BADGE = '当前'
export const SUBS_ACTIVATE_HINT = '点击这一行 = 切到这条订阅（立即生效，不需要保存）'
export const SUBS_ROW_EDIT = '设置'
export const SUBS_ROW_REMOVE = '删除这条订阅'
export const SUBS_ROW_LOCKED = '当前订阅不能删除：先点另一条订阅把它切走'
export const SUBS_RESTORE_DEFAULT = '恢复默认订阅'
export const SUBS_KEY_SLOT = '槽位'
export const SUBS_KEY_STORED = '已存密钥'
export const SUBS_KEY_MISSING = '未存密钥'
export const SUBS_KEY_UNKNOWN = '状态未知'
export const SUBS_KEY_UNKNOWN_HINT = '读不到凭据存储，无法确认这把 key 存了没有（不影响保存和请求）。'
export const SUBS_NAME_LABEL = '名字'
export const SUBS_NAME_PLACEHOLDER = '例如：工作号'
export const SUBS_KEY_LABEL = 'API 密钥'
export const SUBS_KEY_PLACEHOLDER = '粘贴 API 密钥'

/** The session header the relay requires unless configured otherwise (mirrors `DEFAULT_SESSION_HEADER`). */
export const DEFAULT_SESSION_HEADER = 'x-opencode-session'

/** Default credential REFERENCE (a variable name, never a value). */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** Default gateway base including the `/v1` prefix. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** The hint under the session-header input. */
export const SESSION_HEADER_HINT =
  'RFC 7230 token：字母、数字与 !#$%&\'*+-.^_`|~；空格与冒号不合法。'

/**
 * The warning shown while a pre-0.6.0 plain-text `apiKey` is still present in
 * the settings document.
 *
 * It is a warning rather than a hint because the state itself is the problem:
 * the plugin migrates the value on load, and if this is visible the migration
 * could not complete.
 */
export const LEGACY_API_KEY_WARNING =
  '设置文件里还有旧版的明文 apiKey。插件会在启动时把它迁进凭据存储并删除这一项；'
  + '如果这条一直存在，说明迁移没成功（宿主日志里有原因），此时插件仍会临时使用它，请手动处理。'

/** Copy for the "获取可用模型" picker. */
export const FETCH_TITLE = '选择要启用的模型'
// The picker answers a MEMBERSHIP question and nothing else: which ids the
// gateway currently lists. It deliberately makes no capability claim, so this
// copy must not promise one.
export const FETCH_DESCRIPTION =
  '网关当前提供的全部模型（名单以网关披露为准），这里只回答“有哪些”，不显示能力值。'
  + '勾选=启用、取消=停用；点“应用选择”后立即生效，不需要再点保存。'
export const FETCH_SEARCH = '搜索模型'
export const FETCH_EMPTY = '网关没有列出任何模型；可以按 ID 添加，或检查上面的 API 地址/密钥。'
export const FETCH_NO_MATCHES = '没有匹配的模型。'
export const FETCH_SELECT_ALL = '全选'
export const FETCH_DESELECT_ALL = '取消全选'
export const FETCH_APPLY = '应用选择'

/** Copy for the capability sync ("信息同步"). */
export const SYNC_BUTTON = '信息同步'
export const SYNC_STOP = '停止'
export const SYNC_BUSY = '正在同步…'
export const SYNC_NOT_SYNCED = '能力信息还没取过；点“信息同步”才会问网关。'
export const SYNC_HINT =
  '把当前启用的模型逐个问一遍网关：还能不能用、用哪个协议、思考档位到底哪些管用。'
  + '能用的按官方契约补齐；官方没记录的才退化成逐档实测。上下文/输出/图片直接取官方值，不发请求。'

/** The single line the model card shows; `SYNC_HINT` rides its tooltip. */
export const SYNC_NOTE = '按已启用的模型逐个问网关。'

/** Copy for the by-id model adder (a model the gateway list does not show). */
export const ADD_MODEL_LABEL = '按 ID 添加模型'
export const ADD_MODEL_HINT = '输入网关的模型 ID（列表里没有的也能加；内置模型状态认识它的话，能力值会自动带上）。'
export const ADD_MODEL_BUTTON = '添加'
