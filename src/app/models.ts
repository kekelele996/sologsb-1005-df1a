export type Role = 'author' | 'examiner' | 'viewer'

/** 支持映射的迁移状态。active 有效；needs-review 需退回重核；suspended 挂起等人确认。 */
export type LinkStatus = 'active' | 'needs-review' | 'suspended'

/** 退回重核原因：段落换过（特征正文未动）或两侧都动过。 */
export type ReviewReason = 'paragraph-changed' | 'both-changed'

/**
 * 客户侧：说明书段落。anchorId 是跨版本稳定的段落锚点（客户随稿携带），
 * number/section 随版本编号变化，checksum 是正文指纹。
 */
export interface SpecParagraph {
  anchorId: string
  number: number
  section: string
  text: string
  checksum: string
}

/** 客户侧：说明书版本快照。已接收版本不可在工作台改动。 */
export interface SpecVersion {
  id: string
  name: string
  receivedAt: string
  baseVersionId: string | null
  paragraphs: SpecParagraph[]
}

/** 客户侧：客户新稿，先暂存在这里，迁移成功后才成为新版本。 */
export interface StagedDraft {
  name: string
  receivedAt: string
  baseVersionId: string | null
  paragraphs: SpecParagraph[]
  parseError: string | null
  lastApplyError: string | null
}

/** 客户侧持有的状态：说明书正文、段落编号、版本与暂存稿。 */
export interface ClientSideState {
  versions: SpecVersion[]
  activeVersionId: string
  stagedDraft: StagedDraft | null
  viewedVersionId: string | null
}

export interface Claim {
  id: string
  number: number
  title: string
  text: string
  independent: boolean
}

export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  ownerRole: Role
}

/** 挂起映射保留的旧版段落快照，便于人工对照，不允许指向新版不存在的段落。 */
export interface ParagraphSnapshot {
  anchorId: string
  section: string
  text: string
  checksum: string
  versionId: string
}

/**
 * 工作台侧：技术特征 → 说明书段落锚点的支持映射。
 * 映射只认 anchorId，不认版本内编号；挂起时保留旧版快照而非新版段落。
 */
export interface SupportLink {
  id: string
  featureId: string
  anchorId: string
  status: LinkStatus
  reason: string | null
  /** 成为 active 时所对段落的正文指纹。 */
  paragraphChecksum: string
  /** 最近一次人工确认/建立映射时的特征正文指纹。 */
  featureTextChecksum: string
  /** suspended 时的旧版段落快照。 */
  snapshot: ParagraphSnapshot | null
  review: ReviewReason | null
  createdAt: string
  updatedAt: string
}

export interface Annotation {
  id: string
  featureId: string
  authorRole: Role
  authorName: string
  text: string
  updatedAt: string
}

export interface OrphanMapping {
  id: string
  featureLabel: string
  anchorId: string
  paragraphLabel: string
  reason: string
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
  links: SupportLink[]
}

/** 工作台侧持有的状态：权利要求、技术特征、支持映射与批注。 */
export interface WorkbenchSideState {
  claims: Claim[]
  features: Feature[]
  links: SupportLink[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  role: Role
  currentUserRole: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
}

/** 两侧各自持有自己那份；根状态只负责把两份拼在一起。 */
export interface AppState {
  schema: 2
  spec: ClientSideState
  workbench: WorkbenchSideState
}

/** 旧版本机数据（无说明书版本，段落与特征混在同一状态）。 */
export interface LegacyState {
  claims: Claim[]
  paragraphs: Array<{ id: string; section: string; text: string }>
  features: Array<Feature & { supportIds?: string[] }>
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  role: Role
  currentUserRole: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
  [key: string]: unknown
}

export type MigrationAction = 'unchanged' | 'needs-review' | 'suspended' | 'reactivated'

export interface MigrationItem {
  linkId: string
  featureId: string
  featureLabel: string
  /** 迁移前映射持有的锚点。 */
  anchorId: string
  /** 迁移后应指向的锚点（删除段落时为 null，映射保持原锚点并挂起）。 */
  targetAnchorId: string | null
  oldSection: string
  newSection: string | null
  action: MigrationAction
  reason: string
}

export interface MigrationPlan {
  draftName: string
  receivedAt: string
  baseVersionId: string
  baseMatchesActive: boolean
  items: MigrationItem[]
  unchangedCount: number
  reviewCount: number
  suspendedCount: number
  reactivatedCount: number
  activeOnlyCount: number
}

export interface MigrationResult {
  ok: boolean
  error: string | null
  plan: MigrationPlan | null
}

export interface Position {
  tab: string
  claimId: string
  featureId: string | null
  scrollY: number
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature' | 'suspended-mapping' | 'support-review'
  featureId?: string
  linkId?: string
  title: string
  detail: string
}

export interface ImportDraftPayload {
  name?: unknown
  baseVersionId?: unknown
  paragraphs?: unknown
}
