export interface ZentaoManagementSettings {
  enabled: boolean
  plannedReleaseField: string
  actualReleaseField: string
  warningDays: number
  reviewDays: number
  coverageGraceDays: number
}
export const defaultZentaoManagement: ZentaoManagementSettings = {
  enabled: true, plannedReleaseField: '', actualReleaseField: '', warningDays: 3, reviewDays: 3, coverageGraceDays: 3,
}
export type ManagementSeverity = 'red' | 'yellow' | 'gray'
export type ManagementHandling = 'pending' | 'completed' | 'ignored'
export type ManagementQueryState = ManagementHandling | 'resolved'
export interface DateInput { state: 'value' | 'empty' | 'unavailable'; value: string }
export interface EffectiveDate {
  state: 'valid' | 'empty' | 'unavailable' | 'invalid'
  value: string | null
  day: string | null
  timestamp: number | null
  precision: 'day' | 'time'
  source: 'story' | 'execution'
  sourceLabel: string
  fieldPath?: string
}
export interface ReleaseDates {
  planned: EffectiveDate
  actual: EffectiveDate
  fallbackExecutionId: string | null
}
export interface ManagementEntity {
  type: 'story' | 'execution' | 'case' | 'testtask' | 'bug'
  id: string; title: string; owner: string; url: string
}
export interface ManagementTask {
  key: string; ruleId: string; instance: string; account: string
  projectId: string; project: string; executionId: string; execution: string; scopeIds: string[]
  severity: ManagementSeverity; reason: string; action: string; entities: ManagementEntity[]
  dates?: ReleaseDates
  riskState: 'active' | 'resolved'; handlingState: ManagementHandling
  firstSeenAt: string; lastVerifiedAt: string; handledAt: string | null
  resolvedAt: string | null; resolutionReason: string | null; occurrence: number
  stale?: boolean
  history?: { at: string; dates: ReleaseDates }[]
}
export interface ManagementProject { id: string; name: string }
export interface ManagementExecution extends ManagementEntity {
  type: 'execution'; projectId: string; project: string
  status: string; begin: DateInput; end: DateInput; realEnd: DateInput; closedAt: string | null; removed: boolean
}
export interface ManagementStory extends ManagementEntity {
  type: 'story'; status: string; removed: boolean; parent: boolean; version: string
  plannedReleaseAt: DateInput; actualReleaseAt: DateInput; executionIds: string[]
  releaseFields?: { planned: string; actual: string }
  releaseDates?: ReleaseDates
  datesStale?: boolean
  dateHistory?: { at: string; dates: ReleaseDates }[]
}
export interface ManagementCase extends ManagementEntity {
  type: 'case'; storyId: string; status: string; removed: boolean; needConfirm: boolean
  createdBy: string; createdAt: string | null; editedAt: string | null; version: string
  reviewSubmittedAt: string | null; waitSince?: string | null
}
export interface ManagementTestTask extends ManagementEntity { type: 'testtask'; status: string; removed: boolean }
export interface ManagementBug extends ManagementEntity { type: 'bug'; status: string; removed: boolean; severity: number | null; storyId: string }
export interface ManagementScope {
  execution: ManagementExecution
  stories: ManagementStory[]; cases: ManagementCase[]; testtasks: ManagementTestTask[]; bugs: ManagementBug[]
  readable: { stories: boolean; cases: boolean; testtasks: boolean; bugs: boolean }
  issues: string[]; collectedAt: string
}
export interface ManagementBatch {
  instance: string; account: string; collectedAt: string
  executions: ManagementExecution[]; scopes: ManagementScope[]
  associations: Record<string, string[]>; relationsComplete: boolean; issues: string[]
  associationGaps?: string[]
}
export interface ManagementMetrics {
  executionId: string; execution: string; projectId: string; project: string
  collectedAt: string; health: 'red' | 'yellow' | 'green' | 'gray'; incomplete: boolean; issues: string[]
  storyCount: number; released: number; inferredReleased: number; overdue: number
  closed: number; covered: number; reviewPending: number; severeBugs: number; openTesttasks: number
  onTimeReleased: number; datedReleased: number
  unknownMetrics?: ('stories' | 'dates' | 'cases' | 'bugs' | 'testtasks')[]
}
export interface ManagementFieldPreview {
  storyId: string
  planned: DateInput['state']; actual: DateInput['state']
  candidates: { path: string; label: string }[]
  message: string
}
export interface ManagementMember {
  account: string; executionId: string; execution: string; projectId: string
  caseCount: number; sprintCreated: number; recentCreated: number; recentEdited: number; reviewPending: number
}
export interface ManagementOverview {
  metrics: ManagementMetrics[]; members: ManagementMember[]
  history: { day: string; metrics: ManagementMetrics }[]
  issues: string[]; enabled: boolean; lastUpdatedAt: string | null
}
export interface ManagementTaskQuery {
  state?: ManagementQueryState; projectId?: string; executionId?: string; severity?: ManagementSeverity
  offset?: number; limit?: number
}
