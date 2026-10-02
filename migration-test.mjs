// 最小浏览器环境：服务只用到 localStorage、window.addEventListener、window.scrollY。
const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear()
}
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, scrollY: 0 }
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v))

const { WorkbenchService } = await import('./src/app/workbench.service.ts')

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++ }
  else { failed++; console.error('FAIL:', msg) }
}

// ── 用例 1：旧数据（无说明书版本）打开时先迁移到两侧模型 ──
localStorage.clear()
localStorage.setItem('patent-claim-mapping-workbench-v1', JSON.stringify({
  claims: [{ id: 'c1', number: 1, title: 't', text: 'x', independent: true }],
  paragraphs: [
    { id: 'p1', section: '[0001]', text: '段落一正文' },
    { id: 'p2', section: '[0002]', text: '段落二正文' }
  ],
  features: [{ id: 'f1', claimId: 'c1', label: '特征1', text: '特征正文', parentId: null, referenceIds: [], supportIds: ['p1', 'p2'], ownerRole: 'author' }],
  annotations: [], orphanMappings: [], versions: [],
  role: 'author', selectedClaimId: 'c1', selectedFeatureId: 'f1', activeTab: 'mapping', currentUserRole: 'author'
}))
const svc = new WorkbenchService()
let s = svc.snapshot
assert(s.specMigrated === true, '旧数据迁移后 specMigrated=true')
assert(s.specification.paragraphs.length === 2, '旧 paragraphs 迁为客户侧说明书段落')
assert(s.specification.version === 'v1', '旧数据补说明书版本 v1')
assert(s.specification.paragraphs[0].id === 'p1', '迁移保留段落锚点 id')
assert(s.specification.paragraphs[0].number === '[0001]', '迁移保留段落编号')
assert(!('paragraphs' in s), '迁移后旧 paragraphs 字段移除')

// ── 用例 2：换版——锚点仍在且正文未变，映射保留 ──
localStorage.clear()
const svc2 = new WorkbenchService()
const before = svc2.snapshot
const keepResult = svc2.importSpecVersion(JSON.stringify({
  version: 'v2', label: '仅编号变化稿',
  paragraphs: before.specification.paragraphs.map(p => ({ ...p, number: p.number.replace('[00', '[01') }))
}))
assert(keepResult.ok === true, '仅编号变化的换版成功')
assert(keepResult.migrated === 9, '9 条映射全部迁移: ' + keepResult.migrated)
assert(keepResult.suspended === 0, '无挂起')
assert(keepResult.review === 0, '无重核')
const afterKeep = svc2.snapshot
assert(afterKeep.specDrafts.length === 1, '旧稿存档到 specDrafts（旧稿照旧能翻）')
assert(afterKeep.specification.version === 'v2', '当前说明书换为新版')
assert(afterKeep.features.every(f => f.supportIds.length > 0), '所有特征仍有支持映射')

// ── 用例 3：换版——锚点仍在但正文已变，退回重核 ──
localStorage.clear()
const svc3 = new WorkbenchService()
const before3 = svc3.snapshot
const reviewResult = svc3.importSpecVersion(JSON.stringify({
  version: 'v2', label: '正文修改稿',
  paragraphs: before3.specification.paragraphs.map((p, i) => i === 0 ? { ...p, text: p.text + '（补充修订内容）' } : p)
}))
assert(reviewResult.ok === true, '正文修改换版成功')
assert(reviewResult.review === 3, '正文变化触发 3 条重核（para-0012 被 3 个特征引用）: ' + reviewResult.review)
assert(reviewResult.suspended === 0, '无挂起')
const afterReview = svc3.snapshot
assert(afterReview.reviewMappings.length === 3, 'reviewMappings 有 3 条')
assert(afterReview.reviewMappings.every(r => r.anchorId === 'para-0012'), '重核锚点均为 para-0012')
assert(afterReview.features.find(f => f.id === 'feature-a').supportIds.includes('para-0012'), '重核映射仍保留在特征上')

// 确认其中一条重核
svc3.confirmReview('feature-a', 'para-0012')
assert(svc3.snapshot.reviewMappings.length === 2, '确认一条后还剩 2 条重核')

// ── 用例 4：换版——锚点在新版中找不到，映射挂起 ──
localStorage.clear()
const svc4 = new WorkbenchService()
const before4 = svc4.snapshot
const suspendedResult = svc4.importSpecVersion(JSON.stringify({
  version: 'v2', label: '删段稿',
  paragraphs: before4.specification.paragraphs.filter(p => p.id !== 'para-0040')
}))
assert(suspendedResult.ok === true, '删段换版成功')
assert(suspendedResult.suspended === 1, '删除 para-0040 触发 1 条挂起: ' + suspendedResult.suspended)
assert(suspendedResult.migrated === 8, '其余 8 条迁移: ' + suspendedResult.migrated)
const afterSuspended = svc4.snapshot
assert(afterSuspended.suspendedMappings.length === 1, '挂起列表有 1 条')
assert(afterSuspended.suspendedMappings[0].anchorId === 'para-0040', '挂起锚点为 para-0040')
assert(!afterSuspended.features.find(f => f.id === 'feature-d').supportIds.includes('para-0040'), '挂起后映射不再指向 para-0040')
assert(afterSuspended.specification.paragraphs.every(p => p.id !== 'para-0040'), '新版中确实没有 para-0040')

// 挂起项重新挂接到新版段落
const newPara = { id: 'para-0050', number: '[0050]', text: '新段落' }
svc4.importSpecVersion(JSON.stringify({ version: 'v3', paragraphs: [...svc4.snapshot.specification.paragraphs, newPara] }))
const suspId = svc4.snapshot.suspendedMappings[0].id
svc4.relinkSuspended(suspId, 'para-0050')
const afterRelink = svc4.snapshot
assert(afterRelink.suspendedMappings.length === 0, '重新挂接后挂起清除')
assert(afterRelink.features.find(f => f.id === 'feature-d').supportIds.includes('para-0050'), '映射挂接到新段落')

// ── 用例 5：换版失败不改动现有数据，可重试 ──
localStorage.clear()
const svc5 = new WorkbenchService()
const before5 = svc5.snapshot
const failResult = svc5.importSpecVersion('{ 这不是合法 JSON }')
assert(failResult.ok === false, '非法 JSON 换版失败')
assert(failResult.error.includes('解析失败'), '失败原因说明解析失败')
const afterFail = svc5.snapshot
assert(afterFail.specification.version === before5.specification.version, '失败后当前说明书版本不变')
assert(afterFail.specDrafts.length === 0, '失败后不产生旧稿存档')
assert(afterFail.features.every((f, i) => f.supportIds.length === before5.features[i].supportIds.length), '失败后映射不变')

// 失败后重试成功
const retryResult = svc5.importSpecVersion(JSON.stringify({ version: 'v2', paragraphs: before5.specification.paragraphs }))
assert(retryResult.ok === true, '失败后重试成功')
assert(svc5.snapshot.specification.version === 'v2', '重试后换版成功')

// ── 用例 6：客户侧删段，引用该锚点的映射挂起 ──
localStorage.clear()
const svc6 = new WorkbenchService()
svc6.deleteParagraph('para-0012')
const afterDelete = svc6.snapshot
assert(afterDelete.specification.paragraphs.every(p => p.id !== 'para-0012'), '客户侧删段后段落移除')
assert(afterDelete.suspendedMappings.length === 3, '引用 para-0012 的 3 条映射挂起: ' + afterDelete.suspendedMappings.length)
assert(!afterDelete.features.find(f => f.id === 'feature-a').supportIds.includes('para-0012'), '删段后映射不再指向 para-0012')

// ── 用例 7：校验包含挂起与重核问题 ──
localStorage.clear()
const svc7 = new WorkbenchService()
svc7.importSpecVersion(JSON.stringify({
  version: 'v2', label: '混合稿',
  paragraphs: svc7.snapshot.specification.paragraphs.map((p, i) => i === 0 ? { ...p, text: p.text + '（修订）' } : p).filter(p => p.id !== 'para-0040')
}))
const issues = svc7.validate()
assert(issues.some(i => i.type === 'suspended-mapping'), '校验包含挂起问题')
assert(issues.some(i => i.type === 'review-mapping'), '校验包含重核问题')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
