/**
 * Provider connectivity probe (FR-06 rule 3: "key 保存后立即校验有效性").
 *
 * The Models settings page writes the key write-only through the credentials
 * seam — the client never sees the value, so the probe must run host-side.
 * This Typert remote service exposes `hibuddy/verifyProvider`: one minimal
 * completion (maxTokens 1) against the route's first catalog model, classified
 * into product reasons (invalid key / quota / network / not configured) from
 * the structured LlmFailure (status + code) the streaming path carries.
 *
 * The service is instantiated once in apply() with the `llm` face captured up
 * front — cordis discipline: remote callbacks run outside the plugin's
 * injection scope, so lazy `ctx.<service>` reads there would throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmFailure, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Apply the bare `Remote` marker to one prototype method without decorator
 * syntax. tsdown/oxc passes TC39 decorators through untransformed and the dsh
 * host runs plain Node (no decorator support), so the class below cannot use
 * `@Remote` literally — this reproduces the exact same prototype descriptor
 * the decorator would record, through the same public decorator entry point.
 */
function markRemoteMethod(
  constructor: abstract new (...args: never[]) => TypertRemoteService,
  method: string,
): void {
  const prototype: object = constructor.prototype
  Remote(
    (prototype as Record<string, unknown>)[method] as never,
    {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      access: {},
      has: () => true,
      // The decorator records its marker via addInitializer; run it now with
      // a stand-in instance so Object.getPrototypeOf(this) lands on the
      // prototype that owns the method.
      addInitializer: (initializer: () => void) => {
        initializer.call(Object.create(prototype))
      },
    } as never,
  )
}

/** Product-level classification of a failed probe. */
export type VerifyProviderReason =
  /** The endpoint answered 401/403: the key is wrong, revoked, or lacks access. */
  | 'invalid_key'
  /** The endpoint answered 402/429 (or a quota exhaustion body): balance or rate. */
  | 'quota'
  /** The endpoint could not be reached at all (DNS, connect, TLS, timeout). */
  | 'network'
  /** The route has no models / no adapter — configuration incomplete. */
  | 'not_configured'
  /** Anything else; `detail` carries the provider message verbatim. */
  | 'unknown'

/** Wire result of `hibuddy/verifyProvider`. */
export type VerifyProviderOutcome =
  | { ok: true; model: string }
  | { ok: false; reason: VerifyProviderReason; detail: string }

/** Extract the structured failure from a thrown LlmError-shaped error. */
function failureOf(error: unknown): LlmFailure | undefined {
  const failure = (error as { failure?: LlmFailure } | null | undefined)?.failure
  if (failure !== undefined && typeof failure === 'object') return failure
  // Non-LlmError throws still carry a code sometimes (cordis/typert wrappers).
  const code = (error as { code?: string } | null | undefined)?.code
  return code === undefined ? undefined : { message: String(error), code }
}

/** Map one thrown error to the product-level reason taxonomy. */
export function classifyProbeError(error: unknown): { reason: VerifyProviderReason; detail: string } {
  const failure = failureOf(error)
  const status = failure?.status
  const code = failure?.code ?? ''
  const detail = failure?.message ?? (error instanceof Error ? error.message : String(error))
  if (status === 401 || status === 403) return { reason: 'invalid_key', detail }
  if (status === 402 || status === 429) return { reason: 'quota', detail }
  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'NO_ADAPTER':
    case 'UNKNOWN_PROVIDER':
    case 'INVALID_CREDENTIAL':
      return { reason: 'not_configured', detail }
    case 'DISCOVERY_FAILED':
    case 'DISCOVERY_UNSUPPORTED':
      return { reason: 'network', detail }
    default:
      break
  }
  if (status === undefined) {
    // Transport-layer failures surface without an HTTP status: DNS, refused,
    // TLS, timeout, aborted fetch. Distinguish them from provider rejections.
    return { reason: 'network', detail }
  }
  return { reason: 'unknown', detail }
}

/** One host-side provider probe, exposed to the Models page as an extension RPC. */
export class HibuddyVerifyService extends TypertRemoteService {
  private readonly llm: LlmRuntime

  /**
   * @param ctx - host context (registers this service under the `hibuddy` key).
   * @param llm - the LLM runtime face, captured at apply() time.
   */
  constructor(ctx: Context, llm: LlmRuntime) {
    super(ctx, 'hibuddy')
    this.llm = llm
  }

  /**
   * Send one minimal completion against the route's first catalog model and
   * classify the outcome. Never logs or returns key material — failures carry
   * the provider's own message, which by SR-03 must not echo secrets.
   * @param provider - provider route id (e.g. `deepseek-official`, `openai`).
   */
  async verifyProvider(provider: string): Promise<VerifyProviderOutcome> {
    if (typeof provider !== 'string' || provider.length === 0) {
      return { ok: false, reason: 'not_configured', detail: 'provider route is required' }
    }
    let model: string
    try {
      const models = await this.llm.listModels(provider)
      const first = models[0]
      if (first === undefined) {
        return { ok: false, reason: 'not_configured', detail: `provider "${provider}" advertises no models` }
      }
      model = first.id
    } catch (error) {
      const { reason, detail } = classifyProbeError(error)
      return { ok: false, reason, detail }
    }
    const controller = new AbortController()
    try {
      const stream = this.llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        signal: controller.signal,
      })
      for await (const _chunk of stream) {
        // First chunk (even just block-start) proves an authenticated,
        // reachable endpoint accepted the request.
        controller.abort()
        return { ok: true, model }
      }
      // A stream that ends without any chunk is still a successful round trip.
      return { ok: true, model }
    } catch (error) {
      if (controller.signal.aborted) return { ok: true, model }
      const { reason, detail } = classifyProbeError(error)
      return { ok: false, reason, detail }
    }
  }
}

markRemoteMethod(HibuddyVerifyService, 'verifyProvider')
