import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Observable } from 'rxjs'
import type { Annotation, Claim, ClaimVersion, Feature, Position, Role, SpecParagraph, Specification, SuspendedMapping, ReviewMapping, ValidationIssue, WorkbenchState } from './models'

const STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
const POSITION_KEY = 'patent-claim-mapping-position-v1'

let idCounter = 0
function nextId(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}` }

const initialClaims: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]

// 客户侧说明书：段落锚点稳定，编号与正文由客户侧管理。
const initialSpecParagraphs: SpecParagraph[] = [
  { id: 'para-0012', number: '[0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
  { id: 'para-0018', number: '[0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
  { id: 'para-0024', number: '[0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
  { id: 'para-0031', number: '[0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
  { id: 'para-0040', number: '[0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
]
const initialSpecification: Specification = {
  version: 'v1', label: '原始稿', paragraphs: initialSpecParagraphs,
  updatedAt: '2026-09-01T00:00:00.000Z'
}

const initialFeatures: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author' },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author' },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author' },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author' },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author' },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author' }
]
const initialAnnotations: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]

function demoState(): WorkbenchState {
  return {
    specification: clone(initialSpecification), specDrafts: [],
    claims: clone(initialClaims), features: clone(initialFeatures),
    annotations: clone(initialAnnotations), orphanMappings: [],
    suspendedMappings: [], reviewMappings: [], versions: [],
    role: 'author', currentUserRole: 'author', selectedClaimId: 'claim-1',
    selectedFeatureId: 'feature-b', activeTab: 'mapping', specMigrated: true
  }
}
function clone<T>(value: T): T { return structuredClone(value) }

/** 按正文归一化内容生成段落锚点（客户未提供稳定标识时的兜底）。 */
function buildAnchorId(text: string, index: number): string {
  const normalized = text.replace(/\s+/g, '')
  let hash = 0
  for (let i = 0; i < normalized.length; i++) hash = (Math.imul(hash, 31) + normalized.charCodeAt(i)) >>> 0
  return `anchor-${hash.toString(36)}-${index}`
}

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private readonly initialState = this.loadState()
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.initialState)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private past: WorkbenchState[] = []
  private future: WorkbenchState[] = []

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly claims$ = this.state$.pipe(map(state => state.claims))
  readonly features$ = this.state$.pipe(map(state => state.features))
  readonly annotations$ = this.state$.pipe(map(state => state.annotations))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId) || state.claims[0]))
  readonly selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => this.savePosition())
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', () => this.savePosition())
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

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
      const claim: Claim = { id: nextId('claim'), number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      state.selectedClaimId = claim.id
      state.selectedFeatureId = null
    })
  }

  // ── 客户侧：说明书正文与段落编号 ──────────────────────────────

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const next = state.specification.paragraphs.length + 1
      state.specification.paragraphs.push({ id: nextId('para'), number: `[${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<SpecParagraph>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const paragraph = state.specification.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const paragraph = state.specification.paragraphs.find(item => item.id === id)
      state.specification.paragraphs = state.specification.paragraphs.filter(item => item.id !== id)
      // 客户侧删段：引用该锚点的支持映射挂起，不再指向任何段落。
      for (const feature of state.features) {
        if (!feature.supportIds.includes(id)) continue
        feature.supportIds = feature.supportIds.filter(anchorId => anchorId !== id)
        state.suspendedMappings.push({
          id: nextId('suspended'), featureId: feature.id, featureLabel: feature.label,
          anchorId: id, paragraphNumber: paragraph?.number || id, paragraphText: paragraph?.text || '',
          reason: `客户侧删除段落 ${paragraph?.number || id}，支持映射已挂起，等待人工确认。`,
          suspendedAt: new Date().toISOString()
        })
      }
      state.reviewMappings = state.reviewMappings.filter(item => item.anchorId !== id)
    })
  }

  /**
   * 导入新版说明书并按段落锚点迁移支持映射。
   * - 锚点仍在且正文未变：映射保留；
   * - 锚点仍在但正文已变：映射保留并标记退回重核；
   * - 锚点在新版中找不到：映射挂起，不指向任何新段落。
   * 解析或迁移失败时不改动现有数据，可由工作台侧重试；客户旧稿照旧保留。
   */
  importSpecVersion(raw: string): { ok: boolean; error?: string; migrated?: number; suspended?: number; review?: number } {
    let incoming: Specification
    try {
      incoming = this.parseSpecImport(raw)
    } catch (error) {
      return { ok: false, error: `新版说明书解析失败：${(error as Error).message}` }
    }
    if (!incoming.paragraphs.length) return { ok: false, error: '新版说明书没有可用段落。' }
    if (this.stateSubject.value.role === 'viewer') return { ok: false, error: '当前角色只读，不能导入新版说明书。' }

    try {
      let migrated = 0, suspended = 0, review = 0
      this.commit(state => {
        const oldSpec = clone(state.specification)
        const newParaMap = new Map(incoming.paragraphs.map(paragraph => [paragraph.id, paragraph]))
        const oldParaMap = new Map(oldSpec.paragraphs.map(paragraph => [paragraph.id, paragraph]))

        // 客户侧旧稿存档，旧稿照旧能翻。
        state.specDrafts.unshift(oldSpec)
        state.specification = incoming

        for (const feature of state.features) {
          const kept: string[] = []
          for (const anchorId of feature.supportIds) {
            const newParagraph = newParaMap.get(anchorId)
            if (!newParagraph) {
              const oldParagraph = oldParaMap.get(anchorId)
              state.suspendedMappings.push({
                id: nextId('suspended'), featureId: feature.id, featureLabel: feature.label,
                anchorId, paragraphNumber: oldParagraph?.number || anchorId, paragraphText: oldParagraph?.text || '',
                reason: `换版后段落 ${oldParagraph?.number || anchorId} 未在新版说明书中找到，支持映射已挂起，等待人工确认。`,
                suspendedAt: new Date().toISOString()
              })
              suspended++
              continue
            }
            kept.push(anchorId)
            migrated++
            const oldParagraph = oldParaMap.get(anchorId)
            if (oldParagraph && oldParagraph.text !== newParagraph.text) {
              if (!state.reviewMappings.some(item => item.featureId === feature.id && item.anchorId === anchorId)) {
                state.reviewMappings.push({
                  id: nextId('review'), featureId: feature.id, anchorId,
                  reason: `段落 ${newParagraph.number} 正文已更新，而技术特征正文未变动，请重新确认该段落仍支持本特征。`,
                  flaggedAt: new Date().toISOString()
                })
                review++
              }
            }
          }
          feature.supportIds = kept
        }
        // 挂起项保留到人工处理（挂接或丢弃），不随换版自动消失。
        state.specMigrated = true
      })
      return { ok: true, migrated, suspended, review }
    } catch (error) {
      // 迁移中途失败：现有数据未提交，可由工作台侧重试。
      return { ok: false, error: `映射迁移失败，可重试：${(error as Error).message}` }
    }
  }

  /** 翻阅客户旧稿（只读，不影响当前数据）。 */
  viewDraft(index: number): Specification | null {
    const draft = this.stateSubject.value.specDrafts[index]
    return draft ? clone(draft) : null
  }

  /** 丢弃一版客户旧稿。 */
  discardDraft(index: number): void {
    this.commit(state => { state.specDrafts.splice(index, 1) })
  }

  // ── 工作台侧：权利要求、技术特征、支持映射 ───────────────────

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature: Feature = {
        id: nextId('feature'), claimId: state.selectedClaimId,
        label: `新特征 ${state.features.filter(item => item.claimId === state.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: state.role
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
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => state.orphanMappings.push({
        id: nextId('orphan'), featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      state.features = state.features.filter(item => item.id !== id)
      state.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      state.annotations = state.annotations.filter(item => item.featureId !== id)
      state.suspendedMappings = state.suspendedMappings.filter(item => item.featureId !== id)
      state.reviewMappings = state.reviewMappings.filter(item => item.featureId !== id)
      state.selectedFeatureId = state.features.find(item => item.claimId === state.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) {
        feature.supportIds.splice(index, 1)
        state.reviewMappings = state.reviewMappings.filter(item => !(item.featureId === featureId && item.anchorId === paragraphId))
      } else {
        feature.supportIds.push(paragraphId)
      }
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  /** 确认退回重核的映射：新段落仍支持该特征。 */
  confirmReview(featureId: string, anchorId: string): void {
    this.commit(state => {
      state.reviewMappings = state.reviewMappings.filter(item => !(item.featureId === featureId && item.anchorId === anchorId))
    })
  }

  /** 丢弃退回重核的映射：移除支持关系并清除标记。 */
  dismissReview(featureId: string, anchorId: string): void {
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      if (feature) feature.supportIds = feature.supportIds.filter(id => id !== anchorId)
      state.reviewMappings = state.reviewMappings.filter(item => !(item.featureId === featureId && item.anchorId === anchorId))
    })
  }

  /** 把挂起的支持映射重新挂接到新版段落。 */
  relinkSuspended(suspendedId: string, newAnchorId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const suspended = state.suspendedMappings.find(item => item.id === suspendedId)
      if (!suspended) return
      const feature = state.features.find(item => item.id === suspended.featureId)
      if (feature && !feature.supportIds.includes(newAnchorId)) feature.supportIds.push(newAnchorId)
      state.suspendedMappings = state.suspendedMappings.filter(item => item.id !== suspendedId)
      const newParagraph = state.specification.paragraphs.find(item => item.id === newAnchorId)
      if (newParagraph && suspended.paragraphText !== newParagraph.text && feature) {
        state.reviewMappings.push({
          id: nextId('review'), featureId: feature.id, anchorId: newAnchorId,
          reason: `重新挂接的段落 ${newParagraph.number} 正文与旧稿不同，而技术特征正文未变动，请确认该段落仍支持本特征。`,
          flaggedAt: new Date().toISOString()
        })
      }
    })
  }

  /** 丢弃挂起的支持映射。 */
  discardSuspended(suspendedId: string): void {
    this.commit(state => {
      state.suspendedMappings = state.suspendedMappings.filter(item => item.id !== suspendedId)
    })
  }

  clearOrphan(id: string): void {
    this.commit(state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    const names: Record<Role, string> = { author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' }
    this.commit(state => state.annotations.push({
      id: nextId('annotation'), featureId, authorRole: role, authorName: names[role], text: trimmed, updatedAt: new Date().toISOString()
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

  createVersion(name?: string): void {
    this.commit(state => {
      state.versions.unshift({
        id: nextId('version'), name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: clone(state.claims), features: clone(state.features)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit(state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = clone(version.claims)
      state.features = clone(version.features)
      if (!state.claims.some(claim => claim.id === state.selectedClaimId)) state.selectedClaimId = state.claims[0]?.id || ''
      state.selectedFeatureId = state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
    })
  }

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(clone(this.stateSubject.value))
    this.stateSubject.next(previous)
    this.updateHistory()
    this.saveState()
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(clone(this.stateSubject.value))
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
    if (typeof localStorage === 'undefined') return { tab: this.initialState.activeTab, claimId: this.initialState.selectedClaimId, featureId: this.initialState.selectedFeatureId, scrollY: 0 }
    try { return { ...JSON.parse(localStorage.getItem(POSITION_KEY) || '{}'), ...this.stateSubject.value } } catch { return { tab: 'mapping', claimId: this.initialState.selectedClaimId, featureId: this.initialState.selectedFeatureId, scrollY: 0 } }
  }

  exportJson(): string { return JSON.stringify({ ...this.snapshot, validationIssues: this.validate(this.stateSubject.value) }, null, 2) }

  exportCsv(): string {
    const state = this.stateSubject.value
    const rows = state.features.map(feature => [
      state.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      state.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => state.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => state.specification.paragraphs.find(item => item.id === id)?.number || id).join('；')
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  validate(state = this.stateSubject.value): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const feature of state.features) {
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (this.hasReferenceCycle(feature, state.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    state.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
    state.suspendedMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'suspended-mapping', featureId: item.featureId, title: `${item.featureLabel} 的支持映射已挂起`, detail: item.reason }))
    state.reviewMappings.forEach(item => {
      const feature = state.features.find(f => f.id === item.featureId)
      issues.push({ id: item.id, severity: 'warning', type: 'review-mapping', featureId: item.featureId, title: `${feature?.label || '技术特征'} 的支持依据需退回重核`, detail: item.reason })
    })
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

  /** 解析导入的新版说明书：支持段落数组或带 paragraphs 的说明书对象。 */
  private parseSpecImport(raw: string): Specification {
    const data = JSON.parse(raw)
    const now = new Date().toISOString()
    if (Array.isArray(data)) {
      return { version: `v${Date.now()}`, label: '导入稿', paragraphs: data.map((item, index) => this.normalizeParagraph(item, index)), updatedAt: now }
    }
    if (data && Array.isArray(data.paragraphs)) {
      return {
        version: typeof data.version === 'string' && data.version.trim() ? data.version : `v${Date.now()}`,
        label: typeof data.label === 'string' && data.label.trim() ? data.label : '导入稿',
        paragraphs: data.paragraphs.map((item: unknown, index: number) => this.normalizeParagraph(item, index)),
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now
      }
    }
    throw new Error('JSON 必须是段落数组，或包含 paragraphs 字段的说明书对象。')
  }

  private normalizeParagraph(item: unknown, index: number): SpecParagraph {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 段格式不正确。`)
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text : ''
    if (!text.trim()) throw new Error(`第 ${index + 1} 段正文为空。`)
    const id = typeof record.id === 'string' && record.id.trim() ? record.id : buildAnchorId(text, index)
    const number = typeof record.number === 'string' && record.number.trim()
      ? record.number
      : typeof record.section === 'string' && record.section.trim() ? record.section : `段落 ${index + 1}`
    return { id, number, text }
  }

  private commit(recipe: (state: WorkbenchState) => void): void {
    const current = clone(this.stateSubject.value)
    const next = clone(current)
    recipe(next)
    this.past.push(current)
    if (this.past.length > 60) this.past.shift()
    this.future = []
    this.stateSubject.next(next)
    this.updateHistory()
    this.saveState()
  }

  private patchState(recipe: (state: WorkbenchState) => void): void {
    const next = clone(this.stateSubject.value)
    recipe(next)
    this.stateSubject.next(next)
    this.saveState()
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }
  private saveState(): void { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateSubject.value)) }

  /** 本机旧数据缺说明书版本：打开时先迁移到两侧模型再启用。 */
  private loadState(): WorkbenchState {
    if (typeof localStorage === 'undefined') return demoState()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return demoState()
      const parsed = JSON.parse(stored) as Partial<WorkbenchState> & { paragraphs?: Array<{ id?: string; section?: string; text?: string }> }
      if (parsed.specification) return { ...demoState(), ...parsed, specMigrated: true }
      // 旧数据：把 paragraphs 迁为客户侧说明书，补段落锚点与版本。
      const legacyParagraphs = Array.isArray(parsed.paragraphs) ? parsed.paragraphs : []
      const specification: Specification = {
        version: 'v1', label: '迁移稿',
        paragraphs: legacyParagraphs.map((paragraph, index) => ({
          id: paragraph.id || buildAnchorId(paragraph.text || '', index),
          number: paragraph.section || `段落 ${index + 1}`,
          text: paragraph.text || ''
        })),
        updatedAt: new Date().toISOString()
      }
      const migrated: WorkbenchState = {
        ...demoState(), ...parsed,
        specification, specDrafts: [],
        suspendedMappings: [], reviewMappings: [], specMigrated: true
      }
      delete (migrated as unknown as Record<string, unknown>).paragraphs
      return migrated
    } catch { return demoState() }
  }
}
