export type Role = 'author' | 'examiner' | 'viewer'

export interface Claim {
  id: string
  number: number
  title: string
  text: string
  independent: boolean
}

/**
 * 客户侧 · 说明书段落。
 * `id` 是跨版本稳定的段落锚点，换版后编号与正文可能变化，但锚点不变；
 * 说明书正文与段落编号由客户侧持有，工作台只按锚点引用。
 */
export interface SpecParagraph {
  id: string
  number: string
  text: string
}

/** 客户侧 · 说明书版本（客户旧稿保留在 specDrafts 中，照旧能翻）。 */
export interface Specification {
  version: string
  label: string
  paragraphs: SpecParagraph[]
  updatedAt: string
}

export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  /** 引用客户侧段落锚点（SpecParagraph.id），不直接指向段落编号。 */
  supportIds: string[]
  ownerRole: Role
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
  paragraphId: string
  reason: string
}

/**
 * 挂起的支持映射：换版后旧锚点在新版说明书中找不到对应段落，
 * 映射不再指向任何新段落，等待人工确认后重新挂接或丢弃。
 */
export interface SuspendedMapping {
  id: string
  featureId: string
  featureLabel: string
  anchorId: string
  /** 旧段落编号，便于人工辨认。 */
  paragraphNumber: string
  /** 旧段落正文摘要。 */
  paragraphText: string
  reason: string
  suspendedAt: string
}

/**
 * 退回重核的支持映射：锚点仍在新版中，但段落正文已更新，
 * 而技术特征正文未变动，需人工确认新段落是否仍支持该特征。
 */
export interface ReviewMapping {
  id: string
  featureId: string
  anchorId: string
  reason: string
  flaggedAt: string
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
}

export interface Position {
  tab: string
  claimId: string
  featureId: string | null
  scrollY: number
}

export interface WorkbenchState {
  // 客户侧：说明书正文与段落编号
  specification: Specification
  specDrafts: Specification[]
  // 工作台侧：权利要求、技术特征、支持映射
  claims: Claim[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  suspendedMappings: SuspendedMapping[]
  reviewMappings: ReviewMapping[]
  versions: ClaimVersion[]
  // 界面状态
  role: Role
  selectedClaimId: string
  selectedFeatureId: string | null
  activeTab: string
  currentUserRole: Role
  /** 本机旧数据缺说明书版本，打开时先迁移到两侧模型再启用。 */
  specMigrated: boolean
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature' | 'suspended-mapping' | 'review-mapping'
  featureId?: string
  title: string
  detail: string
}
