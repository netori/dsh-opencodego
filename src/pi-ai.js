/**
 * The two translations between the harness vocabulary and pi-ai:
 *
 *   - request side: harness `GenerateOptions` → a pi-ai request context and a
 *     per-model pi-ai `Model` descriptor (which is where a model's own `api`
 *     and `baseUrl` live — the design notes §2.1);
 *   - response side: pi-ai's assistant event stream → harness `StreamChunk`s.
 *
 * Replay: pi-ai needs a native assistant message in the conversation history
 * (tool-call ids, signatures), not just the neutral blocks. The terminal
 * `finish` chunk therefore carries an adapter-private envelope, and a later
 * turn reads it back when the host offers it. Anything unreadable degrades the
 * single message to provider-neutral history instead of failing the request.
 *
 * Images: the request side implements the SAME mechanism as the official
 * `dsh-llm-pi-ai` adapter (`contentHasImage`, `requiredImageOffload`,
 * `projectOffloadedImages`, `offloadedImageText`, `requestImageHandleText`)
 * rather than a home-grown one, so a route that declares image support actually
 * sends the image. When the image cannot be represented the conversion THROWS
 * (`UNSUPPORTED_CONTENT`); it never degrades an image to empty content, because
 * that would silently answer a question about a picture the model never
 * received.
 *
 * Since dsh 0.1.7 the OFFLOAD policy is no longer the route's to apply
 * (`offloadRequestImagesWithPolicy` is gone). A route only COUNTS: when the
 * request still exceeds the route's byte bound it fails with
 * `IMAGE_OFFLOAD_REQUIRED` carrying `offloadImages`, and the host — the
 * `dsh-compaction-image-offload` selection plus the agent's re-derivation —
 * marks that many more oldest occurrences `offloaded: true` and calls again.
 * The route then renders those marks as text placeholders
 * (`projectOffloadedImages`). Applying the policy here would fight the host's
 * accounting and report a request the provider never saw.
 *
 * @module dsh-opencodego/pi-ai
 */

import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import { brandString } from './brand.js'
import { classifyEndpointHealth, ENDPOINT_HEALTH } from './health.js'
import { PI_AI_REASONING_FIELDS } from './vocab.js'

/** Replay envelope version this build writes and accepts. */
const REPLAY_KIND = 'opencode-go-native'
const REPLAY_VERSION = 1

/* ── request side ─────────────────────────────────────────────────────────── */

/** Join the text blocks of one harness message. */
function flattenText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
  return blocks
    .map((block) => block.type === 'text'
      ? block.text
      : block.type === 'tool-result' ? toolResultText(block.content) : '')
    .join('')
}

/** Parse a Raw JSON argument string, degrading to `{}` on malformed input. */
function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // A malformed historical argument string is not worth failing the request.
  }
  return {}
}

/** The zero usage value pi-ai requires on a replayed historical message. */
function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Convert provider-neutral assistant content into a pi-ai assistant message.
 * Used whenever this adapter's own replay envelope is absent or unusable, so
 * history produced by another provider still round-trips.
 * @param {object} message - one harness assistant message.
 * @returns {object} a pi-ai assistant message.
 */
export function foreignAssistant(message) {
  const source = message.source?.kind === 'model' ? message.source : undefined
  const content = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      default:
        // image / file / unknown blocks cannot be represented in pi-ai chat
        // history at this phase; they degrade to nothing rather than throwing.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/**
 * Validate an adapter-private replay envelope.
 * @param {unknown} value - the raw `replayState` from assistant provenance.
 * @returns {{ api: string, stopReason: string, blocks: unknown[] } | undefined}
 *   the usable envelope, or `undefined` when it must degrade.
 */
function readReplayEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const response = value.response
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined
  if (response.kind !== REPLAY_KIND || response.version !== REPLAY_VERSION) return undefined
  if (typeof response.api !== 'string' || response.api.length === 0) return undefined
  if (typeof response.stopReason !== 'string' || response.stopReason.length === 0) return undefined
  const blocks = value.blocks
  if (!Array.isArray(blocks)) return undefined
  return { api: response.api, stopReason: response.stopReason, blocks }
}

/**
 * Correct a replayed thinking block's field name to the one the catalog says
 * this model interleaves its reasoning into.
 *
 * Why this is needed at all: pi-ai's streaming reader records the RAW delta
 * field it found as the thinking block's signature
 * (`openai-completions.js`, `ensureThinkingBlock(thinkingSignature)`), with a
 * hard-coded exception for the provider literally named `opencode-go`. This
 * route is `opencode-go-native`, so a relay that streams reasoning under
 * `reasoning` produces the signature `reasoning`, and replaying that history
 * would send `reasoning: <thinking>` back to a model whose declared
 * interleaved field is `reasoning_content`.
 *
 * Only a KNOWN pi-ai reasoning field is remapped: an absent signature stays
 * absent (this plugin corrects a field name, it does not invent one), and a
 * structured `reasoning_details` signature is left untouched.
 *
 * @param {unknown} signature - the stored `thinkingSignature`.
 * @param {string | undefined} thinkingField - the catalog's interleaved field.
 * @returns {string | undefined} the signature to replay with.
 */
function normalizeThinkingSignature(signature, thinkingField) {
  if (thinkingField === undefined || typeof signature !== 'string') return signature
  if (!PI_AI_REASONING_FIELDS.includes(signature)) return signature
  return thinkingField
}

/**
 * Convert one harness assistant message into pi-ai history, restoring native
 * fidelity from this adapter's own replay envelope when it is present and
 * consistent with the durable content.
 * @param {object} message - one harness assistant message.
 * @param {{ thinkingField?: string }} [facts] - the model's mapped capability facts.
 * @returns {object} a pi-ai assistant message.
 */
export function toPiAssistant(message, facts = {}) {
  const envelope = readReplayEnvelope(message.source?.replayState)
  if (envelope === undefined || envelope.blocks.length !== message.content.length) return foreignAssistant(message)
  const content = []
  for (const [index, block] of message.content.entries()) {
    const replay = envelope.blocks[index]
    if (typeof replay !== 'object' || replay === null || replay.type !== block.type) return foreignAssistant(message)
    switch (block.type) {
      case 'text':
        content.push({
          type: 'text',
          text: block.text,
          ...typeof replay.textSignature === 'string' ? { textSignature: replay.textSignature } : {},
        })
        break
      case 'reasoning': {
        const signature = normalizeThinkingSignature(replay.thinkingSignature, facts.thinkingField)
        content.push({
          type: 'thinking',
          thinking: block.text,
          ...typeof signature === 'string' ? { thinkingSignature: signature } : {},
          ...typeof replay.redacted === 'boolean' ? { redacted: replay.redacted } : {},
        })
        break
      }
      case 'tool-call':
        content.push({
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: parseArguments(block.arguments),
          ...typeof replay.thoughtSignature === 'string' ? { thoughtSignature: replay.thoughtSignature } : {},
        })
        break
      default:
        return foreignAssistant(message)
    }
  }
  return {
    role: 'assistant',
    content,
    api: envelope.api,
    provider: message.source.provider,
    model: message.source.model,
    usage: emptyPiUsage(),
    stopReason: envelope.stopReason,
    timestamp: 0,
  }
}

/**
 * Select the pi-ai `systemPrompt` source. `options.system` wins when defined;
 * otherwise a leading harness `system` message supplies it and folds out of
 * the converted history.
 * @param {object} options - the harness request.
 * @returns {{ systemPrompt: string | undefined, messages: object[] }} the split.
 */
function splitSystemPrompt(options) {
  if (options.system !== undefined) return { systemPrompt: options.system, messages: options.messages }
  const [first, ...rest] = options.messages
  if (first?.role !== 'system') return { systemPrompt: undefined, messages: options.messages }
  const text = flattenText(first)
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/** The tools field of a pi-ai context, when the request carries any. */
function toolsOf(options) {
  return options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope shared by both paths. */
function piContext(systemPrompt, options, messages) {
  const tools = toolsOf(options)
  return {
    ...systemPrompt === undefined ? {} : { systemPrompt },
    messages,
    ...tools === undefined || tools.length === 0 ? {} : { tools },
  }
}

/** Append one assistant message and remember its tool-call ids for tool results. */
function appendAssistant(message, messages, toolNames, facts) {
  const assistant = toPiAssistant(message, facts)
  for (const block of assistant.content) {
    if (block.type === 'toolCall') toolNames.set(brandString(block.id), block.name)
  }
  messages.push(assistant)
}

/**
 * Reject image roles that pi-ai cannot replay.
 *
 * An image in an in-history assistant/tool message has no pi-ai slot, and the
 * official adapter refuses it for the same reason. Doing so here means the
 * refusal happens BEFORE any request is built, so the user learns the truth
 * instead of receiving an answer produced without the image.
 * @param {readonly object[]} messages - the harness history.
 */
function assertSupportedImageRoles(messages) {
  for (const message of messages) {
    if (message.role === 'assistant' && contentHasImage(message.content)) {
      throw new LlmError(
        `opencode-go-native: cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Collect the durable image references of one content list, walking tool results. */
function collectImageRefs(blocks, refs) {
  for (const block of blocks) {
    if (block.type === 'image') {
      // An `offloaded` occurrence is already a placeholder: it has no request
      // version, and preparing bytes for it would both waste work and make the
      // route's byte accounting disagree with what it sends. The official
      // adapter skips them for the same reason.
      if (block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    } else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/**
 * The route-chosen request TARGET for one source.
 *
 * The attachment provider admits `{ width, height, maxBytes }` and validates
 * every member as an integer (`checkedInteger`); the pixel budget is applied by
 * THIS route (`requestImageDimensions`, the provider's own projection) rather
 * than by the provider, because two routes with different budgets need two
 * different versions of the same stored image.
 * @param {object} ref - a durable image reference.
 * @param {{ maxPixels: number, maxBytes: number }} policy - the route's image policy.
 * @returns {{ width: number, height: number, maxBytes: number }} the request target.
 */
function requestImageTarget(ref, policy) {
  return {
    ...requestImageDimensions(ref.width, ref.height, policy.maxPixels),
    maxBytes: policy.maxBytes,
  }
}

/**
 * Prepare one request version per referenced image, through the attachment
 * provider that owns the normalized bytes.
 * @param {readonly object[]} messages - the request history.
 * @param {object} attachments - the durable attachment service.
 * @param {{ maxPixels: number, maxBytes: number }} policy - the route's image policy.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Map<string, object>>} request versions by attachment id.
 */
async function prepareRequestImages(messages, attachments, policy, signal) {
  const refs = new Map()
  for (const message of messages) collectImageRefs(message.content, refs)
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map(
    (ref) => attachments.readImageRequest(ref, requestImageTarget(ref, policy), signal),
  ))
  const versions = new Map()
  for (const [index, ref] of ordered.entries()) versions.set(ref.attachmentId, prepared[index])
  return versions
}

/**
 * Convert one user-role content list, turning image blocks into the pi-ai
 * handle text plus native base64 image content (the shape every pi-ai protocol
 * implementation translates into its own wire form).
 *
 * A content list that is entirely text collapses back to a plain string, which
 * is the shape OpenAI-compatible endpoints expect for an ordinary turn.
 * @param {readonly object[]} blocks - harness content blocks.
 * @param {Map<string, object>} requestImages - prepared request versions.
 * @param {(ref: object) => object | undefined} resolveImageAccess - execution-world path resolver.
 * @returns {Promise<string | object[]>} the pi-ai user content.
 */
async function userContent(blocks, requestImages, resolveImageAccess) {
  const content = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId)
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      case 'tool-result': {
        const nested = await userContent(block.content, requestImages, resolveImageAccess)
        if (typeof nested === 'string') {
          if (nested.length > 0) content.push({ type: 'text', text: nested })
        } else content.push(...nested)
        break
      }
      default:
        // image / file / unknown blocks cannot be represented in pi-ai chat
        // history: a file block never reaches an adapter (the host projects it
        // to handle text first), and an unknown block is forward compatibility.
        break
    }
  }
  if (content.every((block) => block.type === 'text')) return content.map((block) => block.text).join('')
  return content
}

/**
 * The text-only conversion path: used when the request carries no image, and
 * also when it does but no attachment service can convert them — in which case
 * it THROWS instead of dropping the image.
 * @param {object} options - the harness request.
 * @param {{ thinkingField?: string }} facts - the model's mapped capability facts.
 * @returns {object} a pi-ai request context.
 */
function textOnlyContext(options, facts) {
  assertSupportedImageRoles(options.messages)
  const split = splitSystemPrompt(options)
  /** @type {Map<string, string>} */
  const toolNames = new Map()
  const messages = []
  for (const message of split.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError(
        'opencode-go-native: image input requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    if (message.role === 'system') {
      // A mid-history system message has no pi-ai slot; it joins the history as
      // user-visible text, which is how the reference adapter treats it too.
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      appendAssistant(message, messages, toolNames, facts)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: 0 })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(split.systemPrompt, options, messages)
}

/**
 * The image-capable conversion path, mirroring the official adapter:
 *
 *   1. prepare one request version per RETAINED image (the ones the host did not
 *      mark `offloaded`), because only those are sent;
 *   2. measure the request against the route's byte bound at those exact
 *      encoded lengths and, when it still does not fit, fail with
 *      `IMAGE_OFFLOAD_REQUIRED` + the count of oldest occurrences that must go
 *      — the host owns the policy and re-derives the request (see the module
 *      note; dsh 0.1.7 moved this out of the route);
 *   3. render the offloaded marks as deterministic placeholders, so the bytes
 *      that leave here are the bytes that were accounted for.
 *
 * @param {object} options - the harness request.
 * @param {{ thinkingField?: string }} facts - the model's mapped capability facts.
 * @param {object} images - the conversion inputs.
 * @returns {Promise<object>} a pi-ai request context.
 */
async function toPiContextWithImages(options, facts, images) {
  const { attachments, resolveImageAccess, maxRequestImageBytes } = images
  const requestImagePolicy = images.requestImagePolicy ?? { maxPixels: 4_194_304, maxBytes: 1_048_576 }
  assertSupportedImageRoles(options.messages)
  const split = splitSystemPrompt(options)
  const requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, options.signal)
  if (maxRequestImageBytes !== undefined) {
    const offloadImages = requiredImageOffload(split.messages, {
      representation: 'base64',
      maxBytes: maxRequestImageBytes,
      byteQuantum: 1,
    }, (block) => requestImages.get(block.attachment.attachmentId).bytes)
    if (offloadImages > 0) {
      throw new LlmError(
        `opencode-go-native request images exceed the ${maxRequestImageBytes}-byte base64 bound; `
        + `${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
  }
  const exactMessages = projectOffloadedImages(
    split.messages,
    (ref) => offloadedImageText(ref, resolveImageAccess(ref)),
  )
  /** @type {Map<string, string>} */
  const toolNames = new Map()
  const messages = []
  for (const message of exactMessages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      appendAssistant(message, messages, toolNames, facts)
      continue
    }
    const content = await userContent(
      message.content.filter((block) => block.type !== 'tool-result'),
      requestImages,
      resolveImageAccess,
    )
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, requestImages, resolveImageAccess)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent.length > 0 ? resultContent : '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(split.systemPrompt, options, messages)
}

/**
 * Convert a harness request's messages into pi-ai's context vocabulary.
 *
 * Tool results become the dedicated `toolResult` role so providers that key on
 * it (Anthropic-shaped ids) keep call correlation, and an image-carrying turn is
 * converted through the durable attachment service — never dropped.
 *
 * @param {object} options - the harness `GenerateOptions`.
 * @param {{ thinkingField?: string }} [facts] - the model's mapped capability facts.
 * @param {object} [images] - image conversion inputs; omitted for a text-only request.
 * @returns {Promise<object>} a pi-ai request context.
 */
export async function toPiContext(options, facts = {}, images) {
  return images === undefined ? textOnlyContext(options, facts) : toPiContextWithImages(options, facts, images)
}

/* ── response side ────────────────────────────────────────────────────────── */

/**
 * Map pi-ai token accounting onto the harness's disjoint counters.
 * @param {object} usage - pi-ai usage.
 * @returns {object} harness {@link TokenUsage}.
 */
export function mapUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    ...typeof usage.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {},
    ...(usage.cacheRead ?? 0) > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...(usage.cacheWrite ?? 0) > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

/**
 * Classify one pi-ai error string into a stable harness code.
 *
 * The relay's 403s are NOT all credential refusals. A China-hosted model, a
 * data-policy gate, or a country block answers 403 while the key is perfectly
 * good — and the harness renders the `AUTH` code as its own localized sentence
 * ("API key is invalid"), REPLACING the gateway's text. Mislabeling a region
 * gate as `AUTH` therefore costs the operator the one sentence that says what to
 * do, so the endpoint-health taxonomy (`health.js`) decides those cases first
 * and the gateway's own wording reaches the conversation.
 *
 * @param {string} message - the provider error text.
 * @returns {string} the harness error code.
 */
export function classifyPiAiError(message) {
  const text = message ?? ''
  const { category } = classifyEndpointHealth(text)
  if (category === ENDPOINT_HEALTH.REGION
    || category === ENDPOINT_HEALTH.DATA_POLICY
    || category === ENDPOINT_HEALTH.COUNTRY_BLOCK) return 'UNSUPPORTED_MODEL'
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/\b429\b|rate.?limit|quota/i.test(text)) return 'RATE_LIMIT'
  if (/\b(?:413|400)\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(text)) return 'TRANSPORT'
  return 'PROVIDER_ERROR'
}

/**
 * Map a terminal pi-ai assistant message onto a harness finish reason.
 * @param {object} message - the completed pi-ai assistant message.
 * @returns {object} a harness {@link FinishReason}.
 */
export function mapStopReason(message) {
  switch (message?.stopReason) {
    case 'stop':
      return message.content !== undefined && message.content.length === 0
        ? { kind: 'error', failure: { message: `model "${message.model}" returned a completed response with no content`, code: 'EMPTY_RESPONSE' } }
        : { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'stream aborted', code: 'ABORTED' } }
    default: {
      const text = message?.errorMessage ?? `pi-ai stream for model "${message?.model}" ended without a usable result`
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Project a completed pi-ai assistant message into the durable replay
 * envelope. The per-block half stays index-aligned with the emitted blocks so
 * assembly can prune an entry with its block.
 * @param {object} message - the completed pi-ai assistant message.
 * @returns {object} the versioned envelope.
 */
export function toReplayState(message) {
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...message.responseId === undefined ? {} : { responseId: message.responseId },
      ...message.responseModel === undefined ? {} : { responseModel: message.responseModel },
      ...message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel },
      stopReason: message.stopReason ?? 'error',
    },
    blocks: (message.content ?? []).map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', ...block.textSignature === undefined ? {} : { textSignature: block.textSignature } }
        case 'thinking':
          return {
            type: 'reasoning',
            ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
            ...block.redacted === undefined ? {} : { redacted: block.redacted },
          }
        case 'toolCall':
          return { type: 'tool-call', ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature } }
        default:
          return { type: 'unknown' }
      }
    }),
  }
}

/**
 * Translate one pi-ai event stream into harness `StreamChunk`s.
 *
 * pi-ai never throws mid-stream: failures arrive as an `error` event, which
 * becomes an `error` / `aborted` finish chunk. Usage always precedes the
 * terminal finish chunk.
 *
 * @param {AsyncIterable<object>} events - pi-ai assistant events.
 * @param {AbortSignal | undefined} callerSignal - the caller's cancellation.
 * @returns {AsyncIterable<object>} harness chunks.
 */
export async function* toStreamChunks(events, callerSignal) {
  /** @type {Map<number, { id: string, name: string }>} */
  const toolIds = new Map()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial?.content?.[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString(event.toolCall.id),
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments ?? {}),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message?.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message), replayState: toReplayState(event.message) }
        return
      case 'error': {
        const reported = event.error ?? {}
        yield { type: 'usage', usage: mapUsage(reported.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(callerSignal?.aborted === true
            ? { ...reported, stopReason: 'aborted' }
            : reported),
        }
        return
      }
      default:
        break
    }
  }
  throw new Error('opencode-go-native: pi-ai event stream ended without done/error')
}
