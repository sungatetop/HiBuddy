/** Copy for the Run-timeline tab (PRD FR-08, S5-2) and the Markdown exporter. */
export type RunLocaleKey =
  | 'empty'
  | 'runs'
  | 'export'
  | 'exported'
  | 'turn'
  | 'status.running'
  | 'status.completed'
  | 'status.aborted'
  | 'status.blocked'
  | 'status.max-tokens'
  | 'status.interrupted'
  | 'status.forked'
  | 'status.error'
  | 'prompt'
  | 'step'
  | 'tool'
  | 'output'
  | 'toolRunning'
  | 'toolOk'
  | 'toolError'
  | 'args'
  | 'result'
  | 'duration'
  | 'tokens'
  | 'approval'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.waived'
  | 'interrupted'
  | 'noPrompt'
  | 'summary'
  | 'summary.goal'
  | 'summary.result'
  | 'summary.tools'
  | 'summary.noResult'
  | 'stalled'
  | 'export.title'
  | 'export.session'
  | 'export.startedAt'
  | 'export.endedAt'
  | 'export.prompt'
  | 'export.timeline'
  | 'export.step'
  | 'export.tool'
  | 'export.output'
  | 'export.duration'
  | 'export.tokens'
  | 'export.args'
  | 'export.result'
  | 'export.error'
  | 'export.approval'
  | 'export.interrupted'
  | 'export.noPrompt'
  | 'export.summary'
  | 'export.goal'
  | 'export.runResult'
  | 'export.tools'

export const zh: Record<RunLocaleKey, string> = {
  empty: '当前会话暂无运行记录',
  runs: '运行',
  export: '导出 Markdown',
  exported: '已导出',
  turn: 'Turn {n}',
  'status.running': '进行中',
  'status.completed': '已完成',
  'status.aborted': '已中止',
  'status.blocked': '已阻塞',
  'status.max-tokens': '超出令牌上限',
  'status.interrupted': '已中断',
  'status.forked': '已分叉',
  'status.error': '失败',
  prompt: '任务',
  step: '步骤',
  tool: '工具调用',
  output: '产出',
  toolRunning: '运行中',
  toolOk: '完成',
  toolError: '失败',
  args: '参数',
  result: '结果',
  duration: '耗时',
  tokens: '输出令牌',
  approval: '审批',
  'approval.approved': '已批准',
  'approval.rejected': '已拒绝',
  'approval.waived': '本会话免再询',
  interrupted: '已中断',
  noPrompt: '（无提示词）',
  summary: '摘要',
  'summary.goal': '目标',
  'summary.result': '结果',
  'summary.tools': '工具调用统计',
  'summary.noResult': '（运行中，暂无产出）',
  stalled: '已 {n} 秒没有新事件，Run 仍在运行——可能卡住；可在会话输入框打断。',
  'export.title': 'HiBuddy Run 记录',
  'export.session': '会话',
  'export.startedAt': '开始',
  'export.endedAt': '结束',
  'export.prompt': '任务提示',
  'export.timeline': '时间线',
  'export.step': '步骤',
  'export.tool': '工具调用',
  'export.output': '产出',
  'export.duration': '耗时',
  'export.tokens': '输出令牌',
  'export.args': '参数',
  'export.result': '结果摘要',
  'export.error': '失败原因',
  'export.approval': '审批',
  'export.interrupted': '已中断',
  'export.noPrompt': '（无提示词）',
  'export.summary': '摘要',
  'export.goal': '目标',
  'export.runResult': '结果',
  'export.tools': '工具调用统计',
}

export const en: Record<RunLocaleKey, string> = {
  empty: 'No runs recorded in this session yet',
  runs: 'Runs',
  export: 'Export Markdown',
  exported: 'Exported',
  turn: 'Turn {n}',
  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.aborted': 'Aborted',
  'status.blocked': 'Blocked',
  'status.max-tokens': 'Max tokens',
  'status.interrupted': 'Interrupted',
  'status.forked': 'Forked',
  'status.error': 'Failed',
  prompt: 'Prompt',
  step: 'Step',
  tool: 'Tool call',
  output: 'Output',
  toolRunning: 'Running',
  toolOk: 'Done',
  toolError: 'Failed',
  args: 'Arguments',
  result: 'Result',
  duration: 'Duration',
  tokens: 'Output tokens',
  approval: 'Approval',
  'approval.approved': 'Approved',
  'approval.rejected': 'Rejected',
  'approval.waived': 'Session waiver',
  interrupted: 'Interrupted',
  noPrompt: '(no prompt)',
  summary: 'Summary',
  'summary.goal': 'Goal',
  'summary.result': 'Result',
  'summary.tools': 'Tool calls',
  'summary.noResult': '(running, no output yet)',
  stalled: 'No new events for {n}s — the run is still running and may be stuck; you can interrupt it from the composer.',
  'export.title': 'HiBuddy Run record',
  'export.session': 'Session',
  'export.startedAt': 'Started',
  'export.endedAt': 'Ended',
  'export.prompt': 'Prompt',
  'export.timeline': 'Timeline',
  'export.step': 'Step',
  'export.tool': 'Tool call',
  'export.output': 'Output',
  'export.duration': 'Duration',
  'export.tokens': 'Output tokens',
  'export.args': 'Arguments',
  'export.result': 'Result summary',
  'export.error': 'Failure reason',
  'export.approval': 'Approval',
  'export.interrupted': 'interrupted',
  'export.noPrompt': '(no prompt)',
  'export.summary': 'Summary',
  'export.goal': 'Goal',
  'export.runResult': 'Result',
  'export.tools': 'Tool calls',
}
