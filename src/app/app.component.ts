import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ButtonModule } from 'primeng/button'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectModule } from 'primeng/select'
import { CardModule } from 'primeng/card'
import { BadgeModule } from 'primeng/badge'
import { DialogModule } from 'primeng/dialog'
import { TooltipModule } from 'primeng/tooltip'
import { Subscription } from 'rxjs'
import type {
  Annotation, Claim, ClientSideState, Feature, MigrationItem, MigrationPlan,
  Role, SpecVersion, SupportLink, ValidationIssue, WorkbenchSideState
} from './models'
import { WorkbenchService } from './workbench.service'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TextareaModule, SelectModule, CardModule, BadgeModule, DialogModule, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  state: WorkbenchSideState
  specState: ClientSideState
  issues: ValidationIssue[] = []
  history = { past: 0, future: 0 }
  migrationNote = ''
  compareA = ''
  compareB = ''
  annotationDraft = ''
  versionDialog = false
  versionName = ''
  activeIssue: ValidationIssue | null = null

  // 客户新稿换版
  draftDialog = false
  draftText = ''
  draftError = ''
  draftPlan: MigrationPlan | null = null
  applying = false
  applyError = ''
  retargetLink: SupportLink | null = null
  retargetAnchorId: string | null = null

  roleOptions: Array<{ label: string; value: Role }> = [
    { label: '代理人（可编辑主数据与本人批注）', value: 'author' },
    { label: '审查员（可编辑本人批注）', value: 'examiner' },
    { label: '观察者（只读）', value: 'viewer' }
  ]
  private subscriptions = new Subscription()

  constructor(readonly service: WorkbenchService) {
    this.state = service.snapshot
    this.specState = service.spec.snapshot
  }

  ngOnInit(): void {
    this.subscriptions.add(this.service.state$.subscribe(state => {
      this.state = structuredClone(state)
      this.syncVersions()
    }))
    this.subscriptions.add(this.service.specState$.subscribe(spec => { this.specState = structuredClone(spec) }))
    this.subscriptions.add(this.service.issues$.subscribe(issues => this.issues = issues))
    this.subscriptions.add(this.service.history$.subscribe(history => this.history = history))
    this.subscriptions.add(this.service.migrationNote$.subscribe(note => this.migrationNote = note))
    window.addEventListener('keydown', this.handleKeyboard)
  }

  ngAfterViewInit(): void {
    const position = this.service.readPosition()
    setTimeout(() => window.scrollTo({ top: position.scrollY || 0, behavior: 'instant' as ScrollBehavior }), 0)
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
    window.removeEventListener('keydown', this.handleKeyboard)
  }

  get selectedClaim(): Claim | undefined { return this.state.claims.find(item => item.id === this.state.selectedClaimId) }
  get selectedFeature(): Feature | undefined { return this.state.features.find(item => item.id === this.state.selectedFeatureId) }
  get claimFeatures(): Feature[] { return this.state.features.filter(item => item.claimId === this.state.selectedClaimId) }
  get featureAnnotations(): Annotation[] { return this.selectedFeature ? this.state.annotations.filter(item => item.featureId === this.selectedFeature?.id) : [] }
  get currentRoleLabel(): string { return this.roleOptions.find(item => item.value === this.state.role)?.label || '' }
  get errorCount(): number { return this.issues.filter(item => item.severity === 'error').length }
  get warningCount(): number { return this.issues.filter(item => item.severity === 'warning').length }
  get canEditMainData(): boolean { return this.state.role !== 'viewer' }
  get mappedFeatureCount(): number {
    return this.claimFeatures.filter(feature => this.featureLinks(feature.id).some(link => link.status === 'active')).length
  }

  // 两侧数据：段落来自客户侧，映射/特征/权利要求来自工作台侧
  get paragraphs() { return this.service.paragraphs }
  get activeVersion(): SpecVersion { return this.service.spec.activeVersion }
  get viewedVersion(): SpecVersion { return this.service.spec.viewedVersion }
  get viewingOldVersion(): boolean { return !!this.specState.viewedVersionId && this.specState.viewedVersionId !== this.specState.activeVersionId }
  get specVersions(): SpecVersion[] { return this.specState.versions }
  get stagedDraft() { return this.specState.stagedDraft }

  get suspendedLinks(): SupportLink[] { return this.state.links.filter(link => link.status === 'suspended') }
  get reviewLinks(): SupportLink[] { return this.state.links.filter(link => link.status === 'needs-review') }

  claimLabel(id: string): string { return this.state.claims.find(item => item.id === id)?.title || '未命名权利要求' }
  featureLabel(id: string): string { return this.state.features.find(item => item.id === id)?.label || id }
  ownerLabel(role: Role): string { return ({ author: '代理人', examiner: '审查员', viewer: '观察者' })[role] }

  featureLinks(featureId: string): SupportLink[] { return this.state.links.filter(link => link.featureId === featureId) }
  activeLinks(featureId: string): SupportLink[] { return this.featureLinks(featureId).filter(link => link.status === 'active') }
  hasActiveLink(featureId: string): boolean { return this.activeLinks(featureId).length > 0 }
  get selectedActiveCount(): number { return this.selectedFeature ? this.activeLinks(this.selectedFeature.id).length : 0 }
  linkSection(link: SupportLink): string {
    return this.paragraphs.find(paragraph => paragraph.anchorId === link.anchorId)?.section || link.snapshot?.section || link.anchorId
  }
  linkText(link: SupportLink): string {
    return this.paragraphs.find(paragraph => paragraph.anchorId === link.anchorId)?.text || link.snapshot?.text || '（新版中没有该段落）'
  }
  isMapped(feature: Feature | undefined, anchorId: string): boolean {
    return !!feature && this.service.isMapped(feature.id, anchorId)
  }
  linkFor(feature: Feature | undefined, anchorId: string): SupportLink | undefined {
    return feature ? this.featureLinks(feature.id).find(link => link.anchorId === anchorId) : undefined
  }
  isOwnAnnotation(annotation: Annotation): boolean { return annotation.authorRole === this.state.role }

  updateClaimField(field: 'title' | 'text' | 'number' | 'independent', event: Event): void {
    const element = event.target as HTMLInputElement
    const value = field === 'number' ? Number(element.value) : field === 'independent' ? element.checked : element.value
    this.service.updateClaim({ [field]: value })
  }

  updateFeatureField(field: 'label' | 'text', event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
  }

  updateFeatureParent(event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { parentId: (event.target as HTMLSelectElement).value || null })
  }

  toggleReference(featureId: string, checked: boolean): void {
    if (!this.selectedFeature) return
    const ids = checked
      ? Array.from(new Set([...this.selectedFeature.referenceIds, featureId]))
      : this.selectedFeature.referenceIds.filter(id => id !== featureId)
    this.service.updateFeature(this.selectedFeature.id, { referenceIds: ids })
  }

  addAnnotation(): void {
    if (!this.selectedFeature) return
    this.service.addAnnotation(this.selectedFeature.id, this.annotationDraft)
    this.annotationDraft = ''
  }

  updateAnnotation(annotation: Annotation, event: Event): void {
    this.service.updateAnnotation(annotation.id, (event.target as HTMLTextAreaElement).value)
  }

  createVersion(): void {
    this.service.createVersion(this.versionName)
    this.versionName = ''
    this.versionDialog = false
  }

  restoreVersion(id: string): void {
    this.service.restoreVersion(id)
  }

  getVersion(id: string) { return this.state.versions.find(item => item.id === id) }
  compareRows(): Array<{ label: string; before: string; after: string; changed: boolean }> {
    const a = this.getVersion(this.compareA)
    const b = this.getVersion(this.compareB)
    if (!a || !b) return []
    const ids = Array.from(new Set([...a.claims.map(item => item.id), ...b.claims.map(item => item.id)]))
    return ids.map(id => {
      const before = a.claims.find(item => item.id === id)?.text || ''
      const after = b.claims.find(item => item.id === id)?.text || ''
      return { label: `权利要求 ${a.claims.find(item => item.id === id)?.number || b.claims.find(item => item.id === id)?.number || '?'}`, before, after, changed: before !== after }
    })
  }

  exportFile(type: 'json' | 'csv'): void {
    const content = type === 'json' ? this.service.exportJson() : this.service.exportCsv()
    const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `patent-claim-check-${new Date().toISOString().slice(0, 10)}.${type}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  locateIssue(issue: ValidationIssue): void {
    this.activeIssue = issue
    if (issue.featureId) this.service.selectFeature(issue.featureId)
    this.service.setTab('mapping')
  }

  closeIssue(): void { this.activeIssue = null }

  dismissMigration(): void { this.service.dismissMigrationNote() }

  // ---- 说明书版本翻阅（客户侧） ----
  viewVersion(id: string): void { this.service.spec.setViewedVersion(id) }
  backToActiveVersion(): void { this.service.spec.clearViewedVersion() }

  updateParagraphField(anchorId: string, field: 'section' | 'text', event: Event): void {
    const element = event.target as HTMLInputElement | HTMLTextAreaElement
    this.service.updateParagraph(anchorId, { [field]: element.value })
  }

  // ---- 客户新稿换版 ----
  openDraftDialog(): void {
    this.draftDialog = true
    this.draftError = ''
    this.applyError = ''
    this.draftPlan = null
  }

  closeDraftDialog(): void {
    this.draftDialog = false
  }

  stageDraft(): void {
    this.draftError = ''
    this.applyError = ''
    this.draftPlan = null
    const result = this.service.stageDraftFromText(this.draftText)
    if (!result.ok) {
      this.draftError = result.error || '新稿解析失败。'
      return
    }
    this.refreshPlan()
  }

  /** 换版失败后按工作台这边重试：用已暂存的客户新稿重新生成计划。 */
  retryMigration(): void {
    this.applyError = ''
    if (!this.stagedDraft) {
      this.draftError = '暂存稿已丢失，请重新提供客户新稿。'
      return
    }
    this.refreshPlan()
  }

  private refreshPlan(): void {
    const result = this.service.previewMigration()
    if (!result.ok || !result.plan) {
      this.draftError = result.error || '无法生成迁移计划。'
      this.draftPlan = null
      return
    }
    this.draftPlan = result.plan
  }

  applyDraft(): void {
    if (!this.draftPlan) return
    this.applying = true
    try {
      const result = this.service.applyStagedDraft(this.draftPlan)
      if (result.ok) {
        this.draftDialog = false
        this.draftText = ''
        this.draftPlan = null
      } else {
        this.applyError = result.error || '换版失败，可重试。'
      }
    } finally {
      this.applying = false
    }
  }

  cancelDraft(): void {
    this.service.cancelStagedDraft()
    this.draftPlan = null
    this.draftError = ''
    this.applyError = ''
    this.draftText = ''
  }

  itemFeatureLabel(item: MigrationItem): string {
    return this.state.features.find(feature => feature.id === item.featureId)?.label || item.featureLabel
  }

  actionLabel(action: MigrationItem['action']): string {
    return ({ unchanged: '原样迁移', 'needs-review': '退回重核', suspended: '挂起待确认', reactivated: '重新激活' } as const)[action]
  }

  actionIcon(action: MigrationItem['action']): string {
    return ({ unchanged: 'pi pi-check', 'needs-review': 'pi pi-flag', suspended: 'pi pi-pause-circle', reactivated: 'pi pi-reply' } as const)[action]
  }

  // ---- 挂起映射人工处理 ----
  openRetarget(link: SupportLink): void {
    this.retargetLink = link
    this.retargetAnchorId = null
  }
  closeRetarget(): void { this.retargetLink = null; this.retargetAnchorId = null }
  confirmRetarget(): void {
    if (this.retargetLink) this.service.resolveSuspendedLink(this.retargetLink.id, this.retargetAnchorId)
    this.closeRetarget()
  }
  dropAndClose(): void {
    if (this.retargetLink) this.service.resolveSuspendedLink(this.retargetLink.id, null)
    this.closeRetarget()
  }
  dropSuspended(link: SupportLink): void { this.service.resolveSuspendedLink(link.id, null) }
  confirmReview(link: SupportLink): void { this.service.confirmLink(link.id) }

  private syncVersions(): void {
    if (!this.state.versions.some(item => item.id === this.compareA)) this.compareA = this.state.versions[1]?.id || this.state.versions[0]?.id || ''
    if (!this.state.versions.some(item => item.id === this.compareB)) this.compareB = this.state.versions[0]?.id || ''
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? this.service.redo() : this.service.undo()
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.service.redo()
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      this.versionDialog = true
    }
  }
}
