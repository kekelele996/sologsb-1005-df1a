import { Injectable, inject, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Observable } from 'rxjs'
import type {
  Annotation, Claim, Feature, MigrationPlan, MigrationResult,
  ParagraphSnapshot, Position, Role, SpecParagraph, SupportLink, ValidationIssue,
  WorkbenchSideState
} from './models'
import { checksum } from './text-util'
import { SpecService } from './spec.service'
import { migrateLegacy } from './migrate'
import { initialAnnotations, initialClaims, initialFeatures, seedLinks } from './seed'

const STORAGE_KEY = 'patent-workbench-side-v2'
const POSITION_KEY = 'patent-claim-mapping-position-v2'
const MIGRATION_NOTE_KEY = 'patent-workbench-migration-note-v2'

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private readonly specService = inject(SpecService)
  private readonly initialState = this.bootstrap()
  private readonly stateSubject = new BehaviorSubject<WorkbenchSideState>(this.initialState)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private readonly migrationNoteSubject = new BehaviorSubject<string>(this.readMigrationNote())
  private past: WorkbenchSideState[] = []
  private future: WorkbenchSideState[] = []

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly migrationNote$ = this.migrationNoteSubject.asObservable()
  readonly claims$ = this.state$.pipe(map(state => state.claims))
  readonly features$ = this.state$.pipe(map(state => state.features))
  readonly links$ = this.state$.pipe(map(state => state.links))
  readonly annotations$ = this.state$.pipe(map(state => state.annotations))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly specState$ = this.spec.state$
  readonly paragraphs$ = this.spec.state$.pipe(map(state => this.versionParagraphs(state.viewedVersionId || state.activeVersionId)))
  readonly selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId) || state.claims[0]))
  readonly selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => this.savePosition())
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', () => this.savePosition())
  }

  get snapshot(): WorkbenchSideState { return structuredClone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  /** 当前翻阅版本的段落（默认客户侧激活版本；换版失败重试期间可翻旧稿）。 */
  get paragraphs(): SpecParagraph[] {
    const specState = this.spec.snapshot
    return this.versionParagraphs(specState.viewedVersionId || specState.activeVersionId)
  }

  get spec(): SpecService { return this.specService }

  get activeParagraphs(): SpecParagraph[] {
    return this.versionParagraphs(this.spec.snapshot.activeVersionId)
  }

  private versionParagraphs(versionId: string): SpecParagraph[] {
    return this.spec.versionById(versionId)?.paragraphs || this.spec.activeVersion.paragraphs
  }

  selectClaim(id: string): void {
    this.patchState(state => { state.selectedClaimId = id; state.selectedFeatureId = state.features.find(feature => feature.claimId === id)?.id || null })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { state.selectedFeatureId = id })
    this.savePosition()
  }

  setRole(role: Role): void {
    this.patchState(state => { state.role = role; state.currentUserRole = role })
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
    this.savePosition()
  }

  updateClaim(patch: Partial<Claim>): void {
    this.commit(state => {
      const claim = state.claims.find(item => item.id === state.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    this.commit(state => {
      const number = Math.max(0, ...state.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: `claim-${Date.now()}`, number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      state.selectedClaimId = claim.id
      state.selectedFeatureId = null
    })
  }

  // ---- 客户侧操作：只经 SpecService 落到客户那份，不直接改工作台映射 ----

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    const number = Math.max(0, ...this.activeParagraphs.map(paragraph => paragraph.number)) + 1
    this.spec.addParagraph(number, '')
  }

  updateParagraph(anchorId: string, patch: { section?: string; number?: number; text?: string }): void {
    if (this.stateSubject.value.role === 'viewer') return
    const before = this.activeParagraphs.find(paragraph => paragraph.anchorId === anchorId)
    this.spec.updateParagraph(anchorId, patch)
    const after = this.spec.snapshot.versions.find(v => v.id === this.spec.snapshot.activeVersionId)
      ?.paragraphs.find(paragraph => paragraph.anchorId === anchorId)
    // 客户改正文只落在客户侧；工作台侧仅把受影响的有效映射退回重核，绝不指到别处。
    if (before && after && before.checksum !== after.checksum) {
      this.commit(state => {
        state.links.forEach(link => {
          if (link.anchorId === anchorId && link.status === 'active') {
            link.status = 'needs-review'
            link.reason = '客户侧更换了段落正文，支持关系退回重核。'
            link.review = 'paragraph-changed'
            link.paragraphChecksum = after.checksum
            link.updatedAt = new Date().toISOString()
          }
        })
      })
    }
  }

  deleteParagraph(anchorId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    const snapshot = this.spec.snapshotParagraph(anchorId, this.spec.snapshot.activeVersionId)
    // 先在客户侧删除（只动客户那份），再把失去段落的映射挂起，不允许指向不存在的段落。
    this.spec.removeParagraph(anchorId)
    this.commit(state => {
      state.links.forEach(link => {
        if (link.anchorId === anchorId && link.status !== 'suspended') {
          const feature = state.features.find(item => item.id === link.featureId)
          this.suspendLink(link, snapshot, `客户侧删除了段落 ${snapshot?.section || ''}，映射挂起等待人工确认。`)
          if (feature) this.pushOrphan(state, feature.label, anchorId, snapshot?.section || '（已删除段落）', `段落已删除，但特征“${feature.label}”的支持映射仍待人工处理。`)
        }
      })
    })
  }

  // ---- 工作台侧：权利要求 / 技术特征 ----

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature: Feature = {
        id: `feature-${Date.now()}`, claimId: state.selectedClaimId,
        label: `新特征 ${state.features.filter(item => item.claimId === state.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], ownerRole: state.role
      }
      state.features.push(feature)
      state.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
      // 特征正文改动只落在工作台侧；其映射状态保持不变，等下次换版时再据指纹判断是否重核。
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      state.links.filter(link => link.featureId === id).forEach(link => {
        const paragraph = this.activeParagraphs.find(item => item.anchorId === link.anchorId)
        this.pushOrphan(state, feature.label, link.anchorId, paragraph?.section || link.snapshot?.section || '（段落）',
          `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`)
      })
      state.links = state.links.filter(link => link.featureId !== id)
      state.features = state.features.filter(item => item.id !== id)
      state.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      state.annotations = state.annotations.filter(item => item.featureId !== id)
      state.selectedFeatureId = state.features.find(item => item.claimId === state.selectedClaimId)?.id || null
    })
  }

  // ---- 工作台侧：支持映射（只认段落锚点） ----

  toggleParagraphMapping(featureId: string, anchorId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    const paragraph = this.activeParagraphs.find(item => item.anchorId === anchorId)
    if (!paragraph) return // 绝不映射到当前版本不存在的段落
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      const existing = state.links.find(link => link.featureId === featureId && link.anchorId === anchorId)
      if (existing) {
        if (existing.status === 'suspended') return
        state.links = state.links.filter(link => link !== existing)
      } else if (feature) {
        const now = new Date().toISOString()
        state.links.push({
          id: `link-${Date.now()}-${anchorId}`, featureId, anchorId, status: 'active', reason: null,
          paragraphChecksum: paragraph.checksum, featureTextChecksum: checksum(feature.text),
          snapshot: null, review: null, createdAt: now, updatedAt: now
        })
      }
      state.orphanMappings = state.orphanMappings.filter(item => !(item.anchorId === anchorId && item.featureLabel === feature?.label))
    })
  }

  /** 退回重核的映射经人工核对无误后确认恢复。 */
  confirmLink(linkId: string): void {
    this.commit(state => {
      const link = state.links.find(item => item.id === linkId)
      const feature = state.features.find(item => item.id === link?.featureId)
      const paragraph = this.activeParagraphs.find(item => item.anchorId === link?.anchorId)
      if (!link || !paragraph || link.status !== 'needs-review') return
      link.status = 'active'
      link.reason = null
      link.review = null
      link.snapshot = null
      link.paragraphChecksum = paragraph.checksum
      link.featureTextChecksum = checksum(feature?.text ?? '')
      link.updatedAt = new Date().toISOString()
    })
  }

  /**
   * 挂起映射人工处理：指到当前版本确实存在的锚点，或确认放弃。
   * 任择其一都不允许落到新版没有的段落上。
   */
  resolveSuspendedLink(linkId: string, targetAnchorId: string | null): void {
    this.commit(state => {
      const link = state.links.find(item => item.id === linkId)
      if (!link || link.status !== 'suspended') return
      if (targetAnchorId === null) {
        state.links = state.links.filter(item => item.id !== linkId)
        return
      }
      const paragraph = this.activeParagraphs.find(item => item.anchorId === targetAnchorId)
      const feature = state.features.find(item => item.id === link.featureId)
      if (!paragraph) return // 目标锚点在当前版本不存在，拒绝指向
      link.anchorId = targetAnchorId
      link.status = 'active'
      link.reason = null
      link.review = null
      link.snapshot = null
      link.paragraphChecksum = paragraph.checksum
      link.featureTextChecksum = checksum(feature?.text ?? '')
      link.updatedAt = new Date().toISOString()
    })
  }

  clearOrphan(id: string): void {
    this.commit(state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  // ---- 批注 ----

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    const names: Record<Role, string> = { author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' }
    this.commit(state => state.annotations.push({
      id: `annotation-${Date.now()}`, featureId, authorRole: role, authorName: names[role], text: trimmed, updatedAt: new Date().toISOString()
    }))
  }

  updateAnnotation(id: string, text: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) annotation.text = text
    })
  }

  deleteAnnotation(id: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) state.annotations = state.annotations.filter(item => item.id !== id)
    })
  }

  // ---- 权利要求版本（工作台侧，与说明书版本互不影响） ----

  createVersion(name?: string): void {
    this.commit(state => {
      state.versions.unshift({
        id: `version-${Date.now()}`, name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: structuredClone(state.claims),
        features: structuredClone(state.features), links: structuredClone(state.links)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit(state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = structuredClone(version.claims)
      state.features = structuredClone(version.features)
      state.links = structuredClone(version.links)
      if (!state.claims.some(claim => claim.id === state.selectedClaimId)) state.selectedClaimId = state.claims[0]?.id || ''
      state.selectedFeatureId = state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
    })
  }

  // ---- 客户新稿换版：预览 → 确认提交；失败保留旧稿可重试 ----

  previewMigration(): MigrationResult {
    const state = this.stateSubject.value
    return this.spec.buildMigrationPlan(state.links, state.features)
  }

  /**
   * 按迁移计划把映射迁到客户新稿，然后落客户侧新版本。
   * 任何失败都不提交：工作台映射回滚，客户旧稿保持原样、可继续翻阅，可凭同一份暂存稿重试。
   */
  applyStagedDraft(plan: MigrationPlan): MigrationResult {
    const staged = this.spec.stagedDraft
    if (!staged) return { ok: false, error: '客户新稿缺失，换版失败。', plan: null }
    const newByAnchor = new Map(staged.paragraphs.map(paragraph => [paragraph.anchorId, paragraph]))
    const baseVersionId = staged.baseVersionId || this.spec.snapshot.activeVersionId
    const abort = (message: string): MigrationResult => {
      this.spec.markApplyError(message)
      return { ok: false, error: message, plan }
    }

    // 1) 先在副本上算出迁移后的工作台状态，任何映射都不允许指向新版没有的锚点。
    const migrated = this.snapshot
    for (const item of plan.items) {
      const link = migrated.links.find(candidate => candidate.id === item.linkId)
      if (!link) continue
      const feature = migrated.features.find(candidate => candidate.id === link.featureId)
      const now = new Date().toISOString()
      if (item.action === 'unchanged') {
        const target = item.targetAnchorId ?? link.anchorId
        const paragraph = newByAnchor.get(target)
        if (!paragraph) return abort(`原样迁移的锚点 ${target} 在新版中不存在，已中止换版。`)
        link.anchorId = target
        link.paragraphChecksum = paragraph.checksum
        link.updatedAt = now
      } else if (item.action === 'needs-review') {
        const target = item.targetAnchorId ?? link.anchorId
        const paragraph = newByAnchor.get(target)
        if (!paragraph) return abort(`退回重核的锚点 ${target} 在新版中不存在，已中止换版。`)
        link.anchorId = target
        link.status = 'needs-review'
        link.reason = item.reason
        link.review = checksum(feature?.text ?? '') === link.featureTextChecksum ? 'paragraph-changed' : 'both-changed'
        link.paragraphChecksum = paragraph.checksum
        link.snapshot = null
        link.updatedAt = now
      } else if (item.action === 'suspended') {
        const snapshot = link.snapshot || this.spec.snapshotParagraph(link.anchorId, baseVersionId)
        link.status = 'suspended'
        link.reason = item.reason
        link.snapshot = snapshot
        link.updatedAt = now
      } else if (item.action === 'reactivated') {
        const target = item.targetAnchorId ?? link.anchorId
        const paragraph = newByAnchor.get(target)
        if (!paragraph) return abort(`重新激活的锚点 ${target} 在新版中不存在，已中止换版。`)
        link.anchorId = target
        link.status = 'active'
        link.reason = null
        link.review = null
        link.snapshot = null
        link.paragraphChecksum = paragraph.checksum
        link.featureTextChecksum = checksum(feature?.text ?? '')
        link.updatedAt = now
      }
    }
    // 迁移后任何非挂起映射都必须指向新稿里存在的段落。
    const dangling = migrated.links.find(link => link.status !== 'suspended' && !newByAnchor.has(link.anchorId))
    if (dangling) return abort(`映射仍指向新版不存在的段落 ${dangling.anchorId}，已中止换版。`)

    try {
      // 2) 提交客户侧新版本（失败则客户旧稿不动，工作台也没动，可凭暂存稿重试）。
      const version = this.spec.commitNewVersion()
      if (!version) throw new Error('客户侧新版本写入失败。')

      // 3) 客户版本落定后，工作台一次性切到迁移结果。
      this.past.push(structuredClone(this.stateSubject.value))
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.stateSubject.next(migrated)
      this.updateHistory()
      this.saveState()
      return { ok: true, error: null, plan }
    } catch (error) {
      const message = `换版失败，已保留工作台映射与客户旧稿：${(error as Error).message}`
      this.spec.markApplyError(message)
      return { ok: false, error: message, plan }
    }
  }

  stageDraftFromText(text: string): MigrationResult {
    const result = this.spec.stageDraft(text)
    if (!result.ok) this.spec.markApplyError(result.error || '新稿解析失败。')
    return result
  }

  cancelStagedDraft(): void {
    this.spec.clearStagedDraft()
  }

  // ---- 撤销重做（仅工作台侧） ----

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(structuredClone(this.stateSubject.value))
    this.stateSubject.next(previous)
    this.updateHistory()
    this.saveState()
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(structuredClone(this.stateSubject.value))
    this.stateSubject.next(next)
    this.updateHistory()
    this.saveState()
  }

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    const state = this.stateSubject.value
    const position: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: window.scrollY }
    localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    this.saveState()
  }

  readPosition(): Position {
    const fallback: Position = { tab: this.initialState.activeTab, claimId: this.initialState.selectedClaimId, featureId: this.initialState.selectedFeatureId, scrollY: 0 }
    if (typeof localStorage === 'undefined') return fallback
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(POSITION_KEY) || '{}') } } catch { return fallback }
  }

  // ---- 导出 / 展示辅助 ----

  exportJson(): string {
    return JSON.stringify({
      schema: 2,
      spec: this.spec.snapshot,
      workbench: this.snapshot,
      validationIssues: this.validate(this.stateSubject.value)
    }, null, 2)
  }

  exportCsv(): string {
    const state = this.stateSubject.value
    const rows = state.features.map(feature => [
      state.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      state.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => state.features.find(item => item.id === id)?.label || id).join('；'),
      this.activeSectionsForFeature(state, feature.id).join('；')
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  private activeSectionsForFeature(state: WorkbenchSideState, featureId: string): string[] {
    return state.links
      .filter(link => link.featureId === featureId && link.status !== 'suspended')
      .map(link => this.activeParagraphs.find(paragraph => paragraph.anchorId === link.anchorId)?.section || link.snapshot?.section || link.anchorId)
  }

  linksForFeature(featureId: string): SupportLink[] {
    return this.stateSubject.value.links.filter(link => link.featureId === featureId)
  }

  isMapped(featureId: string, anchorId: string): boolean {
    return this.stateSubject.value.links.some(link => link.featureId === featureId && link.anchorId === anchorId && link.status !== 'suspended')
  }

  paragraphLabel(anchorId: string): string {
    return this.activeParagraphs.find(paragraph => paragraph.anchorId === anchorId)?.section
      || this.stateSubject.value.links.find(link => link.anchorId === anchorId)?.snapshot?.section
      || anchorId
  }

  validate(state = this.stateSubject.value): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const feature of state.features) {
      const links = state.links.filter(link => link.featureId === feature.id)
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!links.some(link => link.status === 'active') && !links.some(link => link.status === 'needs-review')) {
        issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少有效说明书依据`, detail: '挂起或缺失的映射不算有效依据，请改指当前版本段落或放弃后重新建立映射。' })
      }
      const review = links.find(link => link.status === 'needs-review')
      if (review) issues.push({ id: review.id, severity: 'warning', type: 'support-review', featureId: feature.id, linkId: review.id, title: `${feature.label} 的支持关系待重核`, detail: review.reason || '说明书段落换版后正文变化，请重新核对支持关系。' })
      const suspended = links.find(link => link.status === 'suspended')
      if (suspended) issues.push({ id: suspended.id, severity: 'warning', type: 'suspended-mapping', featureId: feature.id, linkId: suspended.id, title: `${feature.label} 有挂起映射`, detail: suspended.reason || '该段落未在新版说明书中找到，映射挂起等待人工确认。' })
      if (this.hasReferenceCycle(feature, state.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    state.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: `${item.reason} 对应 ${item.paragraphLabel}` }))
    return issues
  }

  private hasReferenceCycle(start: Feature, features: Feature[]): boolean {
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (id === start.id && visited.size > 0) return true
      if (visited.has(id)) return false
      visited.add(id)
      const feature = features.find(item => item.id === id)
      if (!feature) return false
      if (feature.parentId && visit(feature.parentId)) return true
      return feature.referenceIds.some(visit)
    }
    return visit(start.id)
  }

  private suspendLink(link: SupportLink, snapshot: ParagraphSnapshot | null, reason: string): void {
    link.status = 'suspended'
    link.reason = reason
    link.snapshot = snapshot
    link.updatedAt = new Date().toISOString()
  }

  private pushOrphan(state: WorkbenchSideState, featureLabel: string, anchorId: string, paragraphLabel: string, reason: string): void {
    if (state.orphanMappings.some(item => item.anchorId === anchorId && item.featureLabel === featureLabel)) return
    state.orphanMappings.push({ id: `orphan-${Date.now()}-${anchorId}`, featureLabel, anchorId, paragraphLabel, reason })
  }

  private commit(recipe: (state: WorkbenchSideState) => void): void {
    const current = structuredClone(this.stateSubject.value)
    const next = structuredClone(current)
    recipe(next)
    this.past.push(current)
    if (this.past.length > 60) this.past.shift()
    this.future = []
    this.stateSubject.next(next)
    this.updateHistory()
    this.saveState()
  }

  private patchState(recipe: (state: WorkbenchSideState) => void): void {
    const next = structuredClone(this.stateSubject.value)
    recipe(next)
    this.stateSubject.next(next)
    this.saveState()
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }
  private saveState(): void { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateSubject.value)) }

  private bootstrap(): WorkbenchSideState {
    const outcome = migrateLegacy()
    if (outcome.migrated) {
      this.spec.adoptMigrated(outcome.spec)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(MIGRATION_NOTE_KEY, outcome.summary)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(outcome.workbench))
        localStorage.removeItem('patent-claim-mapping-workbench-v1')
      }
      return outcome.workbench
    }
    return this.loadState()
  }

  private readMigrationNote(): string {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(MIGRATION_NOTE_KEY) || ''
  }

  dismissMigrationNote(): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(MIGRATION_NOTE_KEY)
    this.migrationNoteSubject.next('')
  }

  private loadState(): WorkbenchSideState {
    const seed: WorkbenchSideState = {
      claims: structuredClone(initialClaims),
      features: structuredClone(initialFeatures),
      links: seedLinks(),
      annotations: structuredClone(initialAnnotations),
      orphanMappings: [],
      versions: [],
      role: 'author', currentUserRole: 'author',
      selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b', activeTab: 'mapping'
    }
    if (typeof localStorage === 'undefined') return seed
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<WorkbenchSideState>
        return { ...seed, ...parsed, links: Array.isArray(parsed.links) ? parsed.links : seed.links }
      }
    } catch {
      // 落回种子数据
    }
    return seed
  }
}
