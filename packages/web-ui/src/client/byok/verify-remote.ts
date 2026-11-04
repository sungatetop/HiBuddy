/**
 * Client-side contribution for the `hibuddy` Typert remote namespace (S5-1).
 *
 * dsh mounts client Remote namespaces only through explicit contributions —
 * `ctx.remote.$mount(info)` — and the official api-remotes client applies its
 * own 26 generated artifacts and nothing else, so a plugin namespace stays
 * invisible until it mounts one itself. This hand-written minimal spec mirrors
 * the host face in src/verify-provider.ts, which exports the endpoint through
 * the gateway's SRC fallback (typertRemote binding + Remote-marked prototype
 * method): parameters derive from the function signature and host codecs run
 * in `src-json` pass-through mode. The client therefore keeps the wire shapes
 * strict (one string parameter) while leaving the result unvalidated — no
 * `description` on the result codec means no client-side decode step.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

/** Strict codec of the single `provider` parameter; its strict twin is identical. */
const providerCodec = {
  mode: 'strict',
  typeSymbol: '@hibuddy/web-ui#hibuddy/verifyProvider:provider',
  create: () => z.string(),
  jsonSchema: { type: 'string' },
} as const

/** Mountable descriptor for the Models-page provider probe. */
export const HIBUDDY_REMOTE = createTypertRemoteInfo({
  package: '@hibuddy/web-ui',
  methods: {
    'hibuddy/verifyProvider': {
      service: 'hibuddy',
      description: 'One host-side provider connectivity probe (FR-06 rule 3).',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'provider', source: 'json', codec: providerCodec, strictCodec: providerCodec },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@hibuddy/web-ui#VerifyProviderOutcome',
        create: () => z.union([
          z.object({ ok: z.literal(true), model: z.string() }),
          z.object({
            ok: z.literal(false),
            reason: z.enum(['invalid_key', 'quota', 'network', 'not_configured', 'unknown']),
            detail: z.string(),
          }),
        ]),
      },
    },
  },
}, z)
