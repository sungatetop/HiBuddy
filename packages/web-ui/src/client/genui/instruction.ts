/**
 * Generative-UI instruction reading (ADR-007 §3.2).
 *
 * The model emits a `render_ui` tool call whose arguments ARE the UI
 * instruction. This module projects the call's `ToolArgs` view (the official
 * lazy `PartialArguments` reader, streaming-aware) into a typed instruction:
 *
 * - lightweight string fields (id/target/component/title/summary) surface as
 *   streaming prefixes, so the card skeleton shows what's coming immediately;
 * - `props`/`data` are JSON object fields readable only once closed
 *   (`value()`), so the component renders when its inputs are complete.
 *
 * Type-only imports: the runtime instances arrive as tool-view props from the
 * host, and the import is erased at build time (no loader-module request).
 */
import type { ToolArgs } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Keys of the P0 trusted-component registry (host `render-ui-tool.ts` mirrors the enum). */
export type UiComponentKey = 'chart' | 'form' | 'table' | 'metrics'

/** Where the surface lives. */
export type UiTarget = 'inline' | 'canvas'

/** One render_ui instruction, projected from a tool call's argument view. */
export interface RenderUiInstruction {
  /** Streaming text so far, or the complete value once closed. */
  readonly id: string | undefined
  readonly target: UiTarget | undefined
  readonly title: string | undefined
  readonly component: UiComponentKey | undefined
  readonly props: unknown
  readonly data: unknown
  readonly summary: string | undefined
}

/** Read `key` as a string field: streaming prefix while open, full text once closed. */
function argText(args: ToolArgs, key: string): string | undefined {
  if (!args.has(key)) return undefined
  return args.text(key)
}

/** Read `key` as a closed JSON value; open or absent fields read as undefined. */
function argValue(args: ToolArgs, key: string): unknown {
  if (!args.complete(key)) return undefined
  return args.value(key)
}

/** Project one tool call's argument view into the typed instruction. */
export function readInstruction(args: ToolArgs): RenderUiInstruction {
  const target = argText(args, 'target')
  const component = argText(args, 'component')
  return {
    id: argText(args, 'id'),
    target: target === 'canvas' || target === 'inline' ? target : undefined,
    title: argText(args, 'title'),
    component: component === 'chart' || component === 'form' || component === 'table' || component === 'metrics'
      ? component
      : undefined,
    props: argValue(args, 'props'),
    data: argValue(args, 'data'),
    summary: argText(args, 'summary'),
  }
}

/** True when the instruction carries everything its component needs to render. */
export function instructionReady(instruction: RenderUiInstruction): boolean {
  return instruction.id !== undefined
    && instruction.component !== undefined
    && instruction.props !== undefined
    && instruction.data !== undefined
}
