import { afterEach, describe, expect, it, vi } from 'vitest'
import { RevisionRegistry } from '@hibuddy/web-ui/genui-schema'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ResidentButler } from './butler.ts'
import { createButlerTools } from './butler-tools.ts'
import { clearResidentService, setResidentService } from './service-ref.ts'

/** Minimal service face the two listing tools consume. */
function fakeService(): ResidentButler {
  return {
    listWorkspaces: () => [
      { id: 'w1', title: 'ProjectA', path: 'D:\\ProjectA' },
      { id: 'w2', title: 'ProjectB', path: 'D:\\ProjectB' },
    ],
    listSessions: () => [
      {
        sessionId: 'resident-worker-t1',
        ticketId: 't1',
        goal: '整理下载目录',
        state: 'working',
        workspace: 'D:\\ProjectA',
      },
    ],
  } as unknown as ResidentButler
}

function tool(name: string): ToolDefinition {
  const found = createButlerTools().find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`missing tool ${name}`)
  return found
}

/** Model-facing text of one rendered result. */
function rendered(name: string, value: unknown): string {
  const definition = tool(name)
  return (definition.output.render({}, value as never) as Array<{ type: string; text: string }>)
    .map((block) => block.text)
    .join('\n')
}

afterEach(() => {
  clearResidentService()
})

describe('send_message_to_user feedback (perception B12′ §5.5)', () => {
  it('returns ok:false with a reason when the ledger write fails', async () => {
    setResidentService({ sendMessage: () => ({ id: '', recorded: false }) } as unknown as ResidentButler)
    const value = await tool('send_message_to_user').execute({ text: 'hi', kind: 'text' } as never, {} as never)
    expect(value).toMatchObject({ ok: false, error: '消息未落库' })
    expect(rendered('send_message_to_user', value)).toContain('消息未能记录')
  })

  it('returns ok:true with the recorded id and attachment count', async () => {
    setResidentService({ sendMessage: () => ({ id: 'msg_1', recorded: true }) } as unknown as ResidentButler)
    const value = await tool('send_message_to_user').execute(
      { text: 'hi', kind: 'text', attachments: [{ path: 'D:\\ws\\a.png' }] } as never,
      {} as never,
    )
    expect(value).toMatchObject({ ok: true, id: 'msg_1', attachments: 1 })
    expect(rendered('send_message_to_user', value)).toContain('msg_1')
  })
})

describe('listing tools', () => {
  it('list_workspaces renders every workspace with its path', async () => {
    setResidentService(fakeService())
    const value = await tool('list_workspaces').execute({} as never, {} as never)
    const text = rendered('list_workspaces', value)
    expect(text).toContain('ProjectA')
    expect(text).toContain('D:\\ProjectA')
    expect(text).toContain('ProjectB')
  })

  it('list_sessions renders the session ids the butler must act on', async () => {
    setResidentService(fakeService())
    const value = await tool('list_sessions').execute({} as never, {} as never)
    const text = rendered('list_sessions', value)
    expect(text).toContain('resident-worker-t1')
    expect(text).toContain('working')
    expect(text).toContain('D:\\ProjectA')
  })
})

describe('render_ui butler face (genui-agui-optimization.md G4)', () => {
  it('persists via the service and answers with the ledger reference', async () => {
    const renderUi = vi.fn().mockReturnValue({ id: 'sales-chart', revision: 1, messageId: 'msg_9', recorded: true })
    const genuiRevisions = vi.fn().mockReturnValue(undefined)
    setResidentService({ renderUi, genuiRevisions } as unknown as ResidentButler)
    const value = await tool('render_ui').execute(
      {
        id: 'sales-chart',
        component: 'chart',
        target: 'inline',
        summary: '近六月营收趋势',
        props: { chartType: 'line', xKey: 'month', series: [{ key: 'revenue' }] },
        data: { items: [{ month: '1月', revenue: 120 }] },
      } as never,
      { agent: { session: { id: 'resident-butler' } } } as never,
    )
    expect(value).toMatchObject({ ok: true, id: 'sales-chart', revision: 1, messageId: 'msg_9' })
    expect(renderUi).toHaveBeenCalledTimes(1)
    expect(renderUi).toHaveBeenCalledWith(expect.objectContaining({ id: 'sales-chart', component: 'chart', summary: '近六月营收趋势' }))
    expect(rendered('render_ui', value)).toContain('sales-chart')
  })

  it('registers the revision in the live registry (G2 gate source)', async () => {
    const registry = new RevisionRegistry()
    setResidentService({
      renderUi: () => ({ id: 'f', revision: 3, messageId: 'm', recorded: true }),
      genuiRevisions: () => registry,
    } as unknown as ResidentButler)
    await tool('render_ui').execute(
      { id: 'f', component: 'form', target: 'inline', revision: 3, summary: '表单', props: { fields: [{ id: 'a', label: 'A', type: 'text' }] } } as never,
      { agent: { session: { id: 'resident-butler' } } } as never,
    )
    expect(registry.latest('resident-butler', 'f')).toBe(3)
  })

  it('rejects over-cap instructions with a teaching error before touching the service', async () => {
    const renderUi = vi.fn()
    setResidentService({ renderUi, genuiRevisions: () => undefined } as unknown as ResidentButler)
    // 21 form fields exceed the strict cap of 20 (framework enum checks pass;
    // the strict validator rejects, teaching the model to paginate).
    const fields = Array.from({ length: 21 }, (_, index) => ({ id: `f${index}`, label: `F${index}`, type: 'text' }))
    await expect(
      tool('render_ui').execute({ id: 'x', component: 'form', target: 'inline', summary: 's', props: { fields } } as never, {} as never),
    ).rejects.toThrow(/validation failed/)
    expect(renderUi).not.toHaveBeenCalled()
  })
})
