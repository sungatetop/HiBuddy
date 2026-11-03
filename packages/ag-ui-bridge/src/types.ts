/**
 * Minimal structural mirror of the AG-UI protocol 1.0 wire types
 * (thirdparty/ag-ui sdks/typescript/packages/core/src/generated/types.ts).
 *
 * Only the events this bridge emits and the input it consumes are mirrored —
 * the bridge has no runtime dependency on the AG-UI SDK, so the surface stays
 * reviewable against the vendored spec. Field semantics follow the spec docs
 * under thirdparty/ag-ui/docs/spec/1.0.
 */

// ---------------------------------------------------------------------------
// Input (POST /agui body)
// ---------------------------------------------------------------------------

/** One answer to a previous run's interrupt, sent on the resuming run. */
export interface ResumeEntry {
  interruptId: string
  status: 'resolved' | 'cancelled'
  payload?: unknown
}

/** AG-UI user/assistant/tool message subset the bridge reads (role + content). */
export interface InputMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool' | 'reasoning' | 'activity'
  content?: unknown
}

/** POST /agui request body (RunAgentInput). */
export interface RunAgentInput {
  threadId: string
  runId: string
  protocolVersion?: string
  messages: InputMessage[]
  state?: unknown
  resume?: ResumeEntry[]
  forwardedProps?: unknown
}

// ---------------------------------------------------------------------------
// Emitted events
// ---------------------------------------------------------------------------

/** RUN_FINISHED.outcome discriminated union (spec 1.0: success | interrupt | cancelled). */
export type RunFinishedOutcome =
  | { type: 'success'; pendingToolCallIds?: string[] }
  | { type: 'interrupt'; interrupts: Interrupt[] }
  | { type: 'cancelled' }

/** Something a run needs from outside before it can continue (tool approval here). */
export interface Interrupt {
  id: string
  reason: string
  message?: string
  toolCallId?: string
}

interface EventBase {
  timestamp?: number
}

export interface RunStartedEvent extends EventBase {
  type: 'RUN_STARTED'
  threadId: string
  runId: string
  input?: RunAgentInput
}

export interface RunFinishedEvent extends EventBase {
  type: 'RUN_FINISHED'
  threadId: string
  runId: string
  outcome?: RunFinishedOutcome
}

export interface RunErrorEvent extends EventBase {
  type: 'RUN_ERROR'
  message: string
  code?: string
}

export interface StepStartedEvent extends EventBase {
  type: 'STEP_STARTED'
  stepName: string
}

export interface StepFinishedEvent extends EventBase {
  type: 'STEP_FINISHED'
  stepName: string
}

export interface TextMessageStartEvent extends EventBase {
  type: 'TEXT_MESSAGE_START'
  messageId: string
  role?: 'assistant'
}

export interface TextMessageContentEvent extends EventBase {
  type: 'TEXT_MESSAGE_CONTENT'
  messageId: string
  delta: string
}

export interface TextMessageEndEvent extends EventBase {
  type: 'TEXT_MESSAGE_END'
  messageId: string
}

export interface ToolCallStartEvent extends EventBase {
  type: 'TOOL_CALL_START'
  toolCallId: string
  toolCallName: string
  parentMessageId?: string
}

export interface ToolCallArgsEvent extends EventBase {
  type: 'TOOL_CALL_ARGS'
  toolCallId: string
  delta: string
}

export interface ToolCallEndEvent extends EventBase {
  type: 'TOOL_CALL_END'
  toolCallId: string
}

export interface ToolCallResultEvent extends EventBase {
  type: 'TOOL_CALL_RESULT'
  messageId: string
  toolCallId: string
  content: string
  role?: 'tool'
}

export interface StateSnapshotEvent extends EventBase {
  type: 'STATE_SNAPSHOT'
  snapshot: unknown
}

export interface CustomEvent extends EventBase {
  type: 'CUSTOM'
  name: string
  value: unknown
}

/** Every event this bridge can put on the wire. */
export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | CustomEvent
