import type {
  ClientSideState, LegacyState, SpecVersion, SupportLink, WorkbenchSideState
} from './models'
import { checksum } from './text-util'
import {
  initialAnnotations, initialClaims, initialFeatures, seedLinks, seedSpecParagraphs
} from './seed'

export const LEGACY_STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
export const MIGRATION_FLAG_KEY = 'patent-workbench-v2-migrated'

export interface MigrationOutcome {
  migrated: boolean
  spec: ClientSideState
  workbench: WorkbenchSideState
  summary: string
}

/** 从旧段落 id（para-0012）推导锚点（anc-0012）。 */
function anchorFromLegacyId(id: string, index: number): string {
  const match = id.match(/(\d+)/)
  return `anc-${String(match ? Number(match[1]) : (index + 1) * 5).padStart(4, '0')}`
}

function numberFromSection(section: string, fallback: number): number {
  const match = section.match(/(\d+)/)
  return match ? Number(match[1]) : fallback
}

/**
 * 本机旧数据缺说明书版本：先把旧段落迁成客户侧第一个版本，
 * 再把挂在段落 id 上的映射迁成工作台侧锚点映射，之后才启用工作台。
 * 无旧数据时返回全新两侧初始状态。
 */
export function migrateLegacy(): MigrationOutcome {
  const seedSpec: ClientSideState = {
    versions: [{
      id: 'spec-v-seed',
      name: '客户说明书 · 初版',
      receivedAt: new Date('2026-09-20T02:00:00.000Z').toISOString(),
      baseVersionId: null,
      paragraphs: seedSpecParagraphs()
    }],
    activeVersionId: 'spec-v-seed',
    stagedDraft: null,
    viewedVersionId: null
  }
  const seedWorkbench = (): WorkbenchSideState => ({
    claims: structuredClone(initialClaims),
    features: structuredClone(initialFeatures),
    links: seedLinks(),
    annotations: structuredClone(initialAnnotations),
    orphanMappings: [],
    versions: [],
    role: 'author',
    currentUserRole: 'author',
    selectedClaimId: 'claim-1',
    selectedFeatureId: 'feature-b',
    activeTab: 'mapping'
  })

  if (typeof localStorage === 'undefined') {
    return { migrated: false, spec: seedSpec, workbench: seedWorkbench(), summary: '' }
  }

  let legacy: LegacyState | null = null
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (raw) legacy = JSON.parse(raw) as LegacyState
  } catch {
    legacy = null
  }

  if (!legacy || !Array.isArray(legacy.paragraphs) || !Array.isArray(legacy.features)) {
    return { migrated: false, spec: seedSpec, workbench: seedWorkbench(), summary: '' }
  }

  // 客户侧：旧稿成为第一个（也是当前）说明书版本。
  const paragraphs = legacy.paragraphs.map((paragraph, index) => {
    const anchorId = anchorFromLegacyId(paragraph.id, index)
    const number = numberFromSection(paragraph.section || '', (index + 1) * 5)
    return {
      anchorId,
      number,
      section: paragraph.section || `说明书 [${String(number).padStart(4, '0')}]`,
      text: paragraph.text,
      checksum: checksum(paragraph.text)
    }
  })
  const legacyVersion: SpecVersion = {
    id: 'spec-v-legacy',
    name: '客户说明书 · 旧稿迁移',
    receivedAt: new Date().toISOString(),
    baseVersionId: null,
    paragraphs
  }
  const spec: ClientSideState = {
    versions: [legacyVersion],
    activeVersionId: legacyVersion.id,
    stagedDraft: null,
    viewedVersionId: null
  }

  // 工作台侧：特征去掉 supportIds，逐条映射转成锚点 SupportLink。
  const features = legacy.features.map(feature => {
    const { supportIds: _ignored, ...rest } = feature
    void _ignored
    return rest
  })
  const paragraphByAnchor = new Map(paragraphs.map(paragraph => [paragraph.anchorId, paragraph]))
  const featureById = new Map(features.map(feature => [feature.id, feature]))
  const now = new Date().toISOString()
  const links: SupportLink[] = []
  for (const feature of legacy.features) {
    for (const supportId of feature.supportIds || []) {
      const index = legacy.paragraphs.findIndex(paragraph => paragraph.id === supportId)
      if (index < 0) continue
      const anchorId = anchorFromLegacyId(supportId, index)
      const paragraph = paragraphByAnchor.get(anchorId)
      const currentFeature = featureById.get(feature.id)
      links.push({
        id: `link-${feature.id}-${anchorId}`,
        featureId: feature.id,
        anchorId,
        status: 'active',
        reason: null,
        paragraphChecksum: paragraph?.checksum || '',
        featureTextChecksum: checksum(currentFeature?.text ?? feature.text ?? ''),
        snapshot: null,
        review: null,
        createdAt: now,
        updatedAt: now
      })
    }
  }

  const workbench: WorkbenchSideState = {
    claims: Array.isArray(legacy.claims) ? legacy.claims : structuredClone(initialClaims),
    features,
    links,
    annotations: Array.isArray(legacy.annotations) ? legacy.annotations : [],
    orphanMappings: [],
    versions: [],
    role: legacy.role || 'author',
    currentUserRole: legacy.currentUserRole || legacy.role || 'author',
    selectedClaimId: legacy.selectedClaimId || features[0]?.claimId || 'claim-1',
    selectedFeatureId: legacy.selectedFeatureId || null,
    activeTab: legacy.activeTab || 'mapping'
  }

  const summary = `已从本机旧数据迁移：${paragraphs.length} 个说明书段落归入客户侧，${links.length} 条支持映射归入工作台侧。`
  return { migrated: true, spec, workbench, summary }
}
