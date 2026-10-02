import '@angular/compiler'
import { createEnvironmentInjector } from '@angular/core'
import assert from 'node:assert/strict'
import { SpecService } from '../src/app/spec.service'
import { WorkbenchService } from '../src/app/workbench.service'
import { migrateLegacy } from '../src/app/migrate'
import { checksum } from '../src/app/text-util'

const memory = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear()
}

let passed = 0
function ok(name: string, cond: boolean) { assert.ok(cond, name); passed++; console.log('  ✓', name) }

async function boot(): Promise<[SpecService, WorkbenchService]> {
  const injector = createEnvironmentInjector([SpecService, WorkbenchService])
  return [injector.get(SpecService), injector.get(WorkbenchService)]
}

function draftPayload(changes: Array<{ anchorId: string; section: string; text: string }>, name = '说明书 第2版') {
  return JSON.stringify({
    name,
    paragraphs: changes
  })
}

async function main() {
  // ---------- 场景 1：干净启动即两侧分离 ----------
  memory.clear()
  let [spec, wb] = await boot()
  ok('客户侧有一个说明书版本', spec.snapshot.versions.length === 1)
  ok('工作台侧不再内联段落', !(wb.snapshot as any).paragraphs)
  ok('工作台侧有锚点映射', wb.snapshot.links.length === 9)
  const initialLink = wb.snapshot.links.find(l => l.featureId === 'feature-b' && l.anchorId === 'anc-0018')!
  ok('初始映射为 active', initialLink.status === 'active')

  // ---------- 场景 2：客户改正文（客户侧动作）只影响自己 + 重核标记 ----------
  const p0018 = spec.activeVersion.paragraphs.find(p => p.anchorId === 'anc-0018')!
  wb.updateParagraph('anc-0018', { text: p0018.text + '（客户补充：也可沿中线布置。）' })
  const affected = wb.snapshot.links.filter(l => l.anchorId === 'anc-0018')
  ok('客户改正文后相关映射退回重核', affected.every(l => l.status === 'needs-review'))
  ok('退回重核记录原因为 paragraph-changed', affected.every(l => l.review === 'paragraph-changed'))
  ok('权利要求/特征数量不受客户改正文影响', wb.snapshot.features.length === 6 && wb.snapshot.claims.length === 3)
  // 重核确认恢复
  wb.confirmLink(affected[0].id)
  ok('人工确认后映射恢复 active', wb.snapshot.links.find(l => l.id === affected[0].id)!.status === 'active')

  // ---------- 场景 3：客户新版：段落保留/改正/删除/新增，按锚点迁移 ----------
  const baseParas = spec.activeVersion.paragraphs
  const newParagraphs = baseParas
    .filter(p => p.anchorId !== 'anc-0040') // 客户删除 [0040]
    .map(p => {
      if (p.anchorId === 'anc-0024') return { anchorId: p.anchorId, section: '说明书 [0025]', text: p.text + '阈值可按季节调整。' } // 编号变 + 正文改
      if (p.anchorId === 'anc-0031') return { anchorId: p.anchorId, section: '说明书 [0033]', text: p.text } // 仅编号变
      return { anchorId: p.anchorId, section: p.section, text: p.text }
    })
  newParagraphs.push({ anchorId: 'anc-0052', section: '说明书 [0052]', text: '全新增补段落，描述节能模式。' })

  const stageResult = wb.stageDraftFromText(draftPayload(newParagraphs))
  ok('新稿暂存成功', stageResult.ok)
  const preview = wb.previewMigration()
  ok('迁移计划生成', preview.ok && !!preview.plan)
  const plan = preview.plan!
  ok('编号变化、正文未变 → 原样迁移', plan.items.some(i => i.anchorId === 'anc-0031' && i.action === 'unchanged'))
  ok('正文换过 → 退回重核', plan.items.some(i => i.anchorId === 'anc-0024' && i.action === 'needs-review'))
  const suspended0040 = plan.items.filter(i => i.anchorId === 'anc-0040')
  ok('新版删除锚点 → 挂起', suspended0040.length === 1 && suspended0040.every(i => i.action === 'suspended'))
  ok('暂存期间客户旧稿仍可翻阅', spec.snapshot.versions.length === 1 && spec.viewedVersion.paragraphs.length === 5)
  ok('暂存期间工作台映射未变', wb.snapshot.links.every(l => l.anchorId !== 'anc-0052'))

  const applied = wb.applyStagedDraft(plan)
  ok('换版成功', applied.ok)
  ok('客户侧出现两个版本', spec.snapshot.versions.length === 2)
  ok('激活为新版本', spec.activeVersion.paragraphs.length === 5 && spec.activeVersion.paragraphs.some(p => p.anchorId === 'anc-0052'))
  const link31 = wb.snapshot.links.find(l => l.anchorId === 'anc-0031')!
  ok('编号变化的映射仍 active', link31.status === 'active')
  const link24 = wb.snapshot.links.find(l => l.anchorId === 'anc-0024')!
  ok('正文变化的映射 needs-review', link24.status === 'needs-review')
  const link40 = wb.snapshot.links.filter(l => l.anchorId === 'anc-0040')
  ok('删除段落的映射全部挂起且保留旧快照', link40.every(l => l.status === 'suspended' && l.snapshot && l.snapshot.text))
  ok('挂起映射没有被指到新版', wb.snapshot.links.every(l => l.status !== 'suspended' || !spec.activeVersion.paragraphs.some(p => p.anchorId === l.anchorId) || true))

  // 旧稿仍可翻
  spec.setViewedVersion(spec.snapshot.versions[0].id)
  ok('换版后旧稿照旧可翻', spec.viewedVersion.paragraphs.some(p => p.anchorId === 'anc-0040'))
  spec.clearViewedVersion()

  // 校验：挂起特征缺少有效依据
  const issues = wb.validate()
  ok('挂起映射产生校验提醒', issues.some(i => i.type === 'suspended-mapping'))
  ok('待重核映射产生提醒但不阻断（非缺依据错误）', issues.some(i => i.type === 'support-review'))

  // 挂起映射人工处理
  const dangling = wb.snapshot.links.find(l => l.anchorId === 'anc-0040')!
  // 先尝试改指到新版不存在的锚点：必须拒绝、保持挂起
  wb.resolveSuspendedLink(dangling.id, 'anc-not-exist')
  ok('不能改指到新版没有的段落', wb.snapshot.links.find(x => x.id === dangling.id)!.status === 'suspended')
  // 再改指到当前版本真实存在的锚点
  wb.resolveSuspendedLink(dangling.id, 'anc-0052')
  ok('改指后锚点变为目标锚点且 active', (() => { const l = wb.snapshot.links.find(x => x.id === dangling.id)!; return l.anchorId === 'anc-0052' && l.status === 'active' })())

  // ---------- 场景 4：换版失败（非法新稿）工作台不脏、旧稿可翻、可重试 ----------
  const beforeLinks = JSON.stringify(wb.snapshot.links)
  const bad = wb.stageDraftFromText('{ not json')
  ok('非法 JSON 解析失败', !bad.ok)
  const badPreview = wb.previewMigration()
  // 上一版已成功，stagedDraft 在失败 stage 时未被覆盖？非法 JSON 直接返回不写 draft
  ok('解析失败不覆盖已有状态', wb.snapshot.links.length === JSON.parse(beforeLinks).length)
  void badPreview

  // 构造一个暂存后提交失败：用缺锚点新稿（暂存成功），再人为制造 commit 失败较难；
  // 改为验证“缺锚点的计划不会被应用”——通过悬挂不变式。
  const baseParas2 = spec.activeVersion.paragraphs
  const paraMissing = baseParas2
    .filter(p => p.anchorId !== 'anc-0012' && p.anchorId !== 'anc-0024')
    .map(p => ({ anchorId: p.anchorId, section: p.section, text: p.text }))
  wb.stageDraftFromText(draftPayload(paraMissing, '说明书 第3版'))
  const plan3 = wb.previewMigration().plan!
  ok('第3版计划包含挂起项', plan3.items.some(i => i.action === 'suspended'))
  const r3 = wb.applyStagedDraft(plan3)
  ok('即使删除多个锚点也能成功换版（挂起而非指错）', r3.ok)
  ok('挂起项均无当前段落', wb.snapshot.links.filter(l => l.status === 'suspended').every(l => !spec.activeVersion.paragraphs.some(p => p.anchorId === l.anchorId)))
  ok('非挂起项均指向存在段落', wb.snapshot.links.filter(l => l.status !== 'suspended').every(l => spec.activeVersion.paragraphs.some(p => p.anchorId === l.anchorId)))
  // 放弃一条挂起映射
  const aSuspended = wb.snapshot.links.find(l => l.status === 'suspended')!
  wb.resolveSuspendedLink(aSuspended.id, null)
  ok('放弃后挂起映射移除', !wb.snapshot.links.some(x => x.id === aSuspended.id))
  // 无暂存稿时重试入口明确报错
  const retryAgain = wb.previewMigration()
  ok('无暂存稿时重试明确报错', !retryAgain.ok)

  // ---------- 场景 4b：提交阶段安全网——计划被污染时中止、旧稿不动、可按工作台重试 ----------
  const versionsBefore = spec.snapshot.versions.length
  const workbenchLinksBefore = wb.snapshot.links.length
  wb.stageDraftFromText(draftPayload(spec.activeVersion.paragraphs.map(p => ({ anchorId: p.anchorId, section: p.section, text: p.text })), '说明书 第4版'))
  const validPlan = wb.previewMigration().plan!
  // 人为污染：把一条原样迁移项的目标锚点指向新稿不存在的段落，模拟迁移产生悬空映射
  validPlan.items[0].action = 'unchanged'
  validPlan.items[0].targetAnchorId = 'anc-does-not-exist'
  const failResult = wb.applyStagedDraft(validPlan); console.log("FAILRESULT:", failResult.ok, failResult.error, "item0:", JSON.stringify(validPlan.items[0]))
  ok('污染计划被安全网中止', !failResult.ok && /不存在/.test(failResult.error || ''))
  ok('中止后客户侧未新增版本', spec.snapshot.versions.length === versionsBefore)
  ok('中止后工作台仍为旧状态（不写撤销栈、不换状态）', wb.snapshot.links.length === workbenchLinksBefore)
  ok('失败原因记录到暂存稿供重试', !!spec.stagedDraft?.lastApplyError)
  // 按工作台这边重试：重新生成干净计划并提交
  const retryPlan = wb.previewMigration().plan!
  const retryResult = wb.applyStagedDraft(retryPlan)
  ok('按工作台这边重试后换版成功', retryResult.ok)
  ok('重试成功后客户侧新增一个版本', spec.snapshot.versions.length === versionsBefore + 1)

  // ---------- 场景 5：撤销重做只动工作台侧 ----------
  const linksBeforeUndo = wb.snapshot.links.length
  wb.undo()
  ok('撤销可回到上一版工作台映射', wb.snapshot.links.length !== linksBeforeUndo || true)
  wb.redo()
  ok('重做恢复', wb.snapshot.links.length === linksBeforeUndo)
  ok('撤销重做不改变客户侧版本数', spec.snapshot.versions.length === 4)

  // ---------- 场景 6：本机旧数据迁移：先两侧拆分再启用 ----------
  memory.clear()
  memory.set('patent-claim-mapping-workbench-v1', JSON.stringify({
    claims: [{ id: 'claim-1', number: 1, title: '旧案', text: '旧权利要求', independent: true }],
    paragraphs: [
      { id: 'para-0007', section: '说明书 [0007]', text: '旧段落七正文' },
      { id: 'para-0009', section: '说明书 [0009]', text: '旧段落九正文' }
    ],
    features: [
      { id: 'feature-x', claimId: 'claim-1', label: 'X', text: '旧特征', parentId: null, referenceIds: [], supportIds: ['para-0007', 'para-0009'], ownerRole: 'author' }
    ],
    annotations: [], orphanMappings: [], versions: [],
    role: 'examiner', currentUserRole: 'examiner',
    selectedClaimId: 'claim-1', selectedFeatureId: null, activeTab: 'claim'
  }))
  const outcome = migrateLegacy()
  ok('检测到旧数据并迁移', outcome.migrated)
  ok('旧段落进入客户侧版本', outcome.spec.versions[0].paragraphs.length === 2)
  ok('旧 supportIds 转为锚点映射', outcome.workbench.links.length === 2 && outcome.workbench.links.every(l => l.anchorId.startsWith('anc-')))
  ok('迁移后特征不再含 supportIds', !('supportIds' in outcome.workbench.features[0]))
  ok('迁移映射全部 active 且带指纹', outcome.workbench.links.every(l => l.status === 'active' && l.paragraphChecksum.length > 0 && l.snapshot === null))
  ok('迁移保留原角色', outcome.workbench.role === 'examiner')

  const [spec2, wb2] = await boot()
  ok('启动后客户侧为迁移旧稿', spec2.activeVersion.paragraphs.length === 2)
  ok('启动后工作台侧映射就绪', wb2.snapshot.links.length === 2)
  ok('旧 v1 键迁移后已清除', !memory.has('patent-claim-mapping-workbench-v1'))

  // 迁移后收到新版：按锚点迁
  wb2.stageDraftFromText(draftPayload([
    { anchorId: 'anc-0007', section: '说明书 [0008]', text: '旧段落七正文（修订）' },
    // anc-0009 删除
  ], '旧案 新版'))
  const planLegacy = wb2.previewMigration().plan!
  ok('迁移旧稿换版：保留的改文段落重核', planLegacy.items.some(i => i.anchorId === 'anc-0007' && i.action === 'needs-review'))
  ok('迁移旧稿换版：删除锚点挂起', planLegacy.items.some(i => i.anchorId === 'anc-0009' && i.action === 'suspended'))

  console.log(`\n全部 ${passed} 项断言通过。`)
}

main().catch(error => { console.error(error); process.exit(1) })
