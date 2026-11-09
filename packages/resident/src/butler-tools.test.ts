import { afterEach, describe, expect, it } from 'vitest'
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
