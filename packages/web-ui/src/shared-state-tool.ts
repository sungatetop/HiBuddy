/**
 * The `shared_state` tool — the agent half of the run-level shared task state
 * (PRD FR-05, S4-6).
 *
 * Both sides edit one flat key → {value, source, at} map per session: the
 * user edits the web panel (their edit travels to the model as a
 * `[shared-state update]` queued-turn message, which the model relays into
 * this tool with `source: "user"`), and the agent writes directly. Every
 * write is stamped with its source and a wall-clock time; an incoming write
 * OLDER than the held entry is rejected with the holder reported, so the
 * conflict rule is 新者为准并提示 (A6) — the model must surface the rejection
 * to the user instead of silently overwriting.
 *
 * State is session-scoped and in-memory (like the approval grants): the
 * durable trail is the native tool/call + tool/result session events (FR-08);
 * the browser panel rebuilds its view from those durable calls.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SharedStateStore, type SharedStateSource } from './shared-state.ts'

/** Model-facing description: the shared-state protocol. */
const TOOL_DESCRIPTION = [
  'Read and write the shared task state — one flat map of key → value that you and the user edit together (the user edits the "Shared State" side panel).',
  'Read it at task start and before each step that depends on shared todos/parameters; the user\'s panel edits arrive as "[shared-state update]" messages — apply EACH of them by calling this tool with op:"set", source:"user", and confirm what you applied.',
  'A set may be rejected with a "holder" when a NEWER value already exists (last-writer-wins by time). On rejection, keep the holder and tell the user their edit lost to a newer value — never retry the stale write.',
  'Keys are lowercase-kebab (e.g. "todo", "target-price"). Values are JSON (string/number/boolean/array/object).',
].join('\n')

/** The tool is registered against this store instance (created once per plugin apply). */
export interface SharedStateTool {
  readonly tool: ReturnType<typeof defineTool>
  readonly store: SharedStateStore
}

/** Create the `shared_state` tool bound to one store (per agent composition). */
export function createSharedStateTool(store: SharedStateStore): SharedStateTool['tool'] {
  return defineTool({
    name: 'shared_state',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        enum: ['get', 'set'],
        required: true,
        description: '"get" returns the full shared-state snapshot; "set" writes one key.',
      },
      key: {
        type: 'string',
        required: true,
        description: 'The state key, lowercase-kebab (e.g. "todo", "target-price").',
      },
      value: {
        type: 'json',
        description: 'op:"set" only — the new JSON value for the key.',
      },
      source: {
        type: 'string',
        enum: ['user', 'agent'],
        description: 'op:"set" only — "user" when applying a "[shared-state update]" panel edit from the user; "agent" for your own writes. Defaults to "agent".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', enum: [true], required: true, description: 'The operation was applied.' },
          op: { type: 'string', enum: ['get', 'set'], required: true },
          key: { type: 'string', description: 'op:"set" — the written key.' },
          entry: {
            type: 'object',
            additionalProperties: false,
            description: 'op:"set" — the entry as now held (the holder when rejected).',
            properties: {
              value: { type: 'json', description: 'The held value.' },
              source: { type: 'string', enum: ['user', 'agent'], description: 'Who produced the held value.' },
              at: { type: 'number', description: 'Held write time, unix epoch ms.' },
            },
          },
          rejected: {
            type: 'boolean',
            description: 'op:"set" — true when the write was OLDER than the held entry and was discarded.',
          },
          state: {
            type: 'object',
            additionalProperties: true,
            description: 'The full snapshot after the operation: key → { value, source, at }.',
          },
        },
      },
      render: (args, value) => {
        if (args.op === 'set' && value.entry !== undefined) {
          if (value.rejected === true) {
            return [
              {
                type: 'text' as const,
                text: `Write to "${args.key}" REJECTED — a newer value (source ${value.entry.source}, at ${value.entry.at}) is already held. Keep it and tell the user their edit lost to the newer value.`,
              },
            ]
          }
          return [
            {
              type: 'text' as const,
              text: `Wrote "${args.key}" = ${JSON.stringify(value.entry.value)} (source ${value.entry.source}). Full shared state: ${JSON.stringify(value.state)}`,
            },
          ]
        }
        return [{ type: 'text' as const, text: `Snapshot follows. Full shared state: ${JSON.stringify(value.state)}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new Error('shared_state requires a session-scoped agent')
      const now = Date.now()
      // The store keeps `unknown` values; the canonical output needs lossless
      // JSON nodes, so the projection is a JSON round-trip (never throws for
      // in-memory JSON data).
      const stateOut = () => JSON.parse(JSON.stringify(store.snapshotOf(sessionId)))
      if (args.op === 'get') {
        return { ok: true as const, op: 'get' as const, state: stateOut() }
      }
      const source: SharedStateSource = args.source === 'user' ? 'user' : 'agent'
      const result = store.write(sessionId, args.key, { value: args.value, source, at: now })
      const held = result.ok ? result.entry : result.holder
      return {
        ok: true as const,
        op: 'set' as const,
        key: args.key,
        entry: JSON.parse(JSON.stringify({ value: held.value, source: held.source, at: held.at })),
        rejected: !result.ok,
        state: stateOut(),
      }
    },
  })
}
