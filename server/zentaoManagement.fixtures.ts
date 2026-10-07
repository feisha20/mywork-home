import type { DateInput, ManagementBatch, ManagementCase, ManagementExecution, ManagementStory } from '../shared/zentaoManagement.js'

export const emptyDate: DateInput = { state: 'empty', value: '' }
export const valueDate = (value: string): DateInput => ({ state: 'value', value })
export function managementCase(patch: Partial<ManagementCase> = {}): ManagementCase {
  return { type: 'case', id: '201', title: '登录用例', owner: 'qa1', url: 'https://pm.example/testcase-view-201.html',
    storyId: '101', status: 'normal', removed: false, needConfirm: false, createdBy: 'qa1',
    createdAt: '2026-10-03T01:00:00Z', editedAt: '2026-10-05T01:00:00Z', version: '1', reviewSubmittedAt: null, ...patch }
}
export function managementBatch(now = '2026-10-06T04:00:00Z', storyPatch: Partial<ManagementStory> = {},
  executionPatch: Partial<ManagementExecution> = {}): ManagementBatch {
  const execution: ManagementExecution = { type: 'execution', id: '10', title: '十月冲刺', owner: 'qa-lead',
    url: 'https://pm.example/execution-view-10.html', projectId: '1', project: '测试项目', status: 'doing',
    begin: valueDate('2026-10-01'), end: valueDate('2026-10-07'), realEnd: { ...emptyDate }, closedAt: null, removed: false, ...executionPatch }
  const story: ManagementStory = { type: 'story', id: '101', title: '登录需求', owner: 'developer',
    url: 'https://pm.example/story-view-101.html', status: 'active', removed: false, parent: false, version: '1',
    plannedReleaseAt: { ...emptyDate }, actualReleaseAt: { ...emptyDate }, executionIds: [execution.id], ...storyPatch }
  return { instance: 'https://pm.example', account: 'manager', collectedAt: now, executions: [execution],
    scopes: [{ execution, stories: [story], cases: [managementCase()], bugs: [], testtasks: [],
      readable: { stories: true, cases: true, bugs: true, testtasks: true }, issues: [], collectedAt: now }],
    associations: { [story.id]: [execution.id] }, relationsComplete: true, issues: [] }
}
