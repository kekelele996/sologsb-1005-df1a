import { Injectable } from '@angular/core'
import { BehaviorSubject, type Observable } from 'rxjs'
import type {
  ClientSideState, ImportDraftPayload, MigrationItem, MigrationPlan, MigrationResult,
  ParagraphSnapshot, SpecParagraph, SpecVersion, StagedDraft, SupportLink, Feature
} from './models'
import { checksum } from './text-util'
import { sectionOf, seedSpecParagraphs } from './seed'

const CLIENT_STORAGE_KEY = 'patent-spec-client-side-v2'

@Injectable({ providedIn: 'root' })
export class SpecService {
  private readonly initial = this.load()
  private readonly subject = new BehaviorSubject<ClientSideState>(this.initial)
  readonly state$: Observable<ClientSideState> = this.subject.asObservable()

  get snapshot(): ClientSideState {
    return structuredClone(this.subject.value)
  }

  get activeVersion(): SpecVersion {
    const state = this.subject.value
    return state.versions.find(version => version.id === state.activeVersionId) || state.versions[0]
  }

  get stagedDraft(): StagedDraft | null {
    return this.subject.value.stagedDraft
  }

  get hasStagedDraft(): boolean {
    return this.subject.value.stagedDraft !== null
  }

  /** 当前正在翻阅的版本（换版失败重试期间客户可翻旧稿）。 */
  get viewedVersion(): SpecVersion {
    const state = this.subject.value
    return state.versions.find(version => version.id === (state.viewedVersionId || state.activeVersionId)) || this.activeVersion
  }

  versionById(id: string): SpecVersion | undefined {
    return this.subject.value.versions.find(version => version.id === id)
  }

  setViewedVersion(id: string): void {
    this.patch(state => { state.viewedVersionId = id })
  }

  clearViewedVersion(): void {
    this.patch(state => { state.viewedVersionId = null })
  }

  /** 客户侧编辑：只落在客户这份上，绝不触碰工作台的映射。 */
  updateParagraph(anchorId: string, patch: { section?: string; number?: number; text?: string }): void {
    this.patch(state => {
      // 已接收版本冻结，客户侧只允许在“在编草稿”（当前激活版本）上调整编号/正文
      const version = state.versions.find(item => item.id === state.activeVersionId)
      if (!version) return
      const paragraph = version.paragraphs.find(item => item.anchorId === anchorId)
      if (!paragraph) return
      if (patch.number !== undefined) paragraph.number = patch.number
      if (patch.section !== undefined) paragraph.section = patch.section
      if (patch.text !== undefined) { paragraph.text = patch.text; paragraph.checksum = checksum(patch.text) }
    })
  }

  addParagraph(number: number, text = ''): SpecParagraph {
    const state = this.subject.value
    const anchorId = `anc-${Date.now()}`
    const paragraph: SpecParagraph = { anchorId, number, section: sectionOf(number), text, checksum: checksum(text) }
    this.patch(draft => {
      const version = draft.versions.find(item => item.id === draft.activeVersionId)
      version?.paragraphs.push(structuredClone(paragraph))
    })
    return paragraph
  }

  /** 客户侧删除段落：只从客户这份移除，不触碰工作台侧的映射。 */
  removeParagraph(anchorId: string): void {
    this.patch(state => {
      const version = state.versions.find(item => item.id === state.activeVersionId)
      if (!version) return
      version.paragraphs = version.paragraphs.filter(item => item.anchorId !== anchorId)
    })
  }

  /**
   * 客户发来新版：解析 JSON 新稿并暂存。新稿带自己的段落锚点，
   * 不覆盖任何现有版本，工作台侧完全不动，等确认后再迁移。
   */
  stageDraft(payload: ImportDraftPayload | string): MigrationResult {
    let parsed: ImportDraftPayload
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
    } catch (error) {
      return { ok: false, error: `新稿不是合法 JSON：${(error as Error).message}`, plan: null }
    }
    const paragraphsResult = this.parseParagraphs(parsed.paragraphs)
    if (!paragraphsResult.ok || !paragraphsResult.paragraphs) {
      return { ok: false, error: paragraphsResult.error || '新稿段落解析失败。', plan: null }
    }
    const state = this.snapshot
    const baseVersionId = typeof parsed.baseVersionId === 'string' && state.versions.some(v => v.id === parsed.baseVersionId)
      ? parsed.baseVersionId
      : state.activeVersionId
    const draft: StagedDraft = {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : `客户新稿 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      receivedAt: new Date().toISOString(),
      baseVersionId,
      paragraphs: paragraphsResult.paragraphs,
      parseError: null,
      lastApplyError: null
    }
    this.patch(current => { current.stagedDraft = draft })
    return { ok: true, error: null, plan: null }
  }

  clearStagedDraft(): void {
    this.patch(state => { state.stagedDraft = null })
  }

  /** 解析失败时记录到暂存稿，工作台按这份重试；客户旧稿照常可翻。 */
  markApplyError(message: string): void {
    this.patch(state => {
      if (state.stagedDraft) state.stagedDraft.lastApplyError = message
    })
  }

  /**
   * 生成迁移计划：按段落锚点把映射迁到新稿。
   * 新版没有对应锚点的映射一律挂起，绝不指向新版里没有的段落。
   * @param links 工作台侧全部支持映射
   * @param features 工作台侧特征（用于判断“段落换过而特征正文没动”）
   */
  buildMigrationPlan(links: SupportLink[], features: Feature[] = []): MigrationResult {
    const state = this.subject.value
    const draft = state.stagedDraft
    if (!draft) return { ok: false, error: '客户新稿尚未提供，无法换版。', plan: null }
    const base = state.versions.find(version => version.id === draft.baseVersionId)
    if (!base) return { ok: false, error: `找不到新稿所依据的旧版“${draft.baseVersionId}”。`, plan: null }

    const oldByAnchor = new Map(base.paragraphs.map(paragraph => [paragraph.anchorId, paragraph]))
    const newByAnchor = new Map(draft.paragraphs.map(paragraph => [paragraph.anchorId, paragraph]))
    const featureById = new Map(features.map(feature => [feature.id, feature]))

    const items: MigrationItem[] = []
    for (const link of links) {
      const oldParagraph = oldByAnchor.get(link.anchorId)
      const newParagraph = newByAnchor.get(link.anchorId)

      // 挂起中的映射：新版仍无此锚点 → 继续挂起；新版补回该锚点 → 重新激活（或退回重核）
      if (link.status === 'suspended') {
        if (!newParagraph) {
          items.push(this.item(link, oldParagraph, null, 'suspended', '新版说明书仍没有该段落，映射继续挂起，等待人工确认。'))
          continue
        }
        const paraChanged = !oldParagraph || oldParagraph.checksum !== newParagraph.checksum
        if (paraChanged) {
          items.push(this.item(link, oldParagraph, newParagraph, 'needs-review', '新版补回了该段落但正文有改动，已重新激活并退回重核。'))
        } else {
          items.push(this.item(link, oldParagraph, newParagraph, 'reactivated', '新版补回了该段落，映射重新激活。'))
        }
        continue
      }

      if (!newParagraph) {
        items.push(this.item(link, oldParagraph, null, 'suspended', '新版说明书中找不到对应段落锚点，映射已挂起，等待人工确认。'))
        continue
      }

      const paraChanged = !oldParagraph || oldParagraph.checksum !== newParagraph.checksum
      // 段落换过而特征正文没动（自上次人工确认起未改）→ 退回重核；两者都没动 → 原样迁移。
      if (paraChanged) {
        const feature = featureById.get(link.featureId)
        const featureChanged = checksum(feature?.text ?? '') !== link.featureTextChecksum
        items.push(this.item(
          link, oldParagraph, newParagraph, 'needs-review',
          featureChanged
            ? '段落与特征正文均已更换，支持关系退回重核。'
            : '段落已更换而特征正文未动，支持关系退回重核。'
        ))
      } else {
        items.push(this.item(link, oldParagraph, newParagraph, 'unchanged', '段落锚点与正文一致，映射原样迁移。'))
      }
    }

    for (const item of items) {
      item.featureLabel = featureById.get(item.featureId)?.label || item.featureId
    }

    const plan: MigrationPlan = {
      draftName: draft.name,
      receivedAt: draft.receivedAt,
      baseVersionId: base.id,
      baseMatchesActive: base.id === state.activeVersionId,
      items,
      unchangedCount: items.filter(item => item.action === 'unchanged').length,
      reviewCount: items.filter(item => item.action === 'needs-review').length,
      suspendedCount: items.filter(item => item.action === 'suspended').length,
      reactivatedCount: items.filter(item => item.action === 'reactivated').length,
      activeOnlyCount: links.filter(link => link.status !== 'suspended').length
    }
    return { ok: true, error: null, plan }
  }

  /**
   * 换版提交：落新版本。由工作台在成功迁移映射后调用；
   * 任何一步失败都不提交，客户旧稿保持不动、可继续翻阅。
   */
  commitNewVersion(): SpecVersion | null {
    const state = this.snapshot
    const draft = state.stagedDraft
    if (!draft) return null
    const version: SpecVersion = {
      id: `spec-v-${Date.now()}`,
      name: draft.name,
      receivedAt: draft.receivedAt,
      baseVersionId: draft.baseVersionId,
      paragraphs: structuredClone(draft.paragraphs)
    }
    this.patch(current => {
      current.versions.push(version)
      current.activeVersionId = version.id
      current.viewedVersionId = null
      current.stagedDraft = null
    })
    return version
  }

  snapshotParagraph(anchorId: string, versionId: string): ParagraphSnapshot | null {
    const version = this.versionById(versionId)
    const paragraph = version?.paragraphs.find(item => item.anchorId === anchorId)
    if (!paragraph) return null
    return { anchorId, section: paragraph.section, text: paragraph.text, checksum: paragraph.checksum, versionId }
  }

  private item(
    link: SupportLink,
    oldParagraph: SpecParagraph | undefined,
    newParagraph: SpecParagraph | null,
    action: MigrationItem['action'],
    reason: string
  ): MigrationItem {
    return {
      linkId: link.id,
      featureId: link.featureId,
      featureLabel: '',
      anchorId: link.anchorId,
      targetAnchorId: newParagraph ? newParagraph.anchorId : null,
      oldSection: oldParagraph?.section || link.snapshot?.section || '（旧版段落）',
      newSection: newParagraph ? newParagraph.section : null,
      action,
      reason
    }
  }

  private parseParagraphs(raw: unknown): { ok: boolean; paragraphs?: SpecParagraph[]; error?: string } {
    if (!Array.isArray(raw)) return { ok: false, error: '新稿缺少 paragraphs 数组。' }
    const paragraphs: SpecParagraph[] = []
    const anchors = new Set<string>()
    for (let index = 0; index < raw.length; index++) {
      const entry = raw[index] as Record<string, unknown>
      if (!entry || typeof entry !== 'object') return { ok: false, error: `第 ${index + 1} 段不是对象。` }
      const anchorId = String(entry.anchorId ?? '').trim()
      const text = typeof entry.text === 'string' ? entry.text : ''
      if (!anchorId) return { ok: false, error: `第 ${index + 1} 段缺少 anchorId 段落锚点。` }
      if (anchors.has(anchorId)) return { ok: false, error: `段落锚点 ${anchorId} 在新稿中重复。` }
      anchors.add(anchorId)
      const number = typeof entry.number === 'number' && Number.isFinite(entry.number)
        ? entry.number
        : this.extractNumber(String(entry.section ?? '')) ?? (index + 1) * 5
      paragraphs.push({
        anchorId,
        number,
        section: typeof entry.section === 'string' && entry.section.trim() ? entry.section : sectionOf(number),
        text,
        checksum: checksum(text)
      })
    }
    return { ok: true, paragraphs }
  }

  private extractNumber(section: string): number | null {
    const match = section.match(/(\d+)/)
    return match ? Number(match[1]) : null
  }

  private patch(recipe: (state: ClientSideState) => void): void {
    const next = this.snapshot
    recipe(next)
    this.subject.next(next)
    this.persist(next)
  }

  private persist(state: ClientSideState): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CLIENT_STORAGE_KEY, JSON.stringify(state))
  }

  private load(): ClientSideState {
    if (typeof localStorage === 'undefined') return this.seed()
    try {
      const stored = localStorage.getItem(CLIENT_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ClientSideState>
        if (parsed.versions?.length && parsed.activeVersionId) return parsed as ClientSideState
      }
    } catch {
      // 落回种子数据
    }
    return this.seed()
  }

  /** 由旧数据迁移器注入：把旧稿作为客户侧第一个版本。 */
  adoptMigrated(state: ClientSideState): void {
    this.subject.next(state)
    this.persist(state)
  }

  private seed(): ClientSideState {
    const first: SpecVersion = {
      id: 'spec-v-seed',
      name: '客户说明书 · 初版',
      receivedAt: new Date('2026-09-20T02:00:00.000Z').toISOString(),
      baseVersionId: null,
      paragraphs: seedSpecParagraphs()
    }
    return { versions: [first], activeVersionId: first.id, stagedDraft: null, viewedVersionId: null }
  }
}
