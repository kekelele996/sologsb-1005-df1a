import { checksum } from './text-util'
import type { Annotation, Claim, Feature, SpecParagraph, SupportLink } from './models'

export const initialClaims: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]

const SPEC_SEED_RAW: Array<[number, string]> = [
  [12, '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。'],
  [18, '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。'],
  [24, '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。'],
  [31, '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。'],
  [40, '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。']
]

export function sectionOf(number: number): string {
  return `说明书 [${String(number).padStart(4, '0')}]`
}

export function seedSpecParagraphs(): SpecParagraph[] {
  return SPEC_SEED_RAW.map(([number, text]) => ({
    anchorId: `anc-${String(number).padStart(4, '0')}`,
    number,
    section: sectionOf(number),
    text,
    checksum: checksum(text)
  }))
}

export const initialFeatures: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], ownerRole: 'author' },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], ownerRole: 'author' },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], ownerRole: 'author' },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], ownerRole: 'author' },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], ownerRole: 'author' },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], ownerRole: 'author' }
]

const SEED_SUPPORT: Array<[string, string[]]> = [
  ['feature-a', ['anc-0012']],
  ['feature-b', ['anc-0012', 'anc-0018']],
  ['feature-c', ['anc-0012', 'anc-0031']],
  ['feature-d', ['anc-0024', 'anc-0040']],
  ['feature-e', ['anc-0018']],
  ['feature-f', ['anc-0024']]
]

export function seedLinks(now = new Date().toISOString()): SupportLink[] {
  const paragraphs = new Map(seedSpecParagraphs().map(paragraph => [paragraph.anchorId, paragraph]))
  const features = new Map(initialFeatures.map(feature => [feature.id, feature]))
  const links: SupportLink[] = []
  for (const [featureId, anchorIds] of SEED_SUPPORT) {
    for (const anchorId of anchorIds) {
      const paragraph = paragraphs.get(anchorId)
      const feature = features.get(featureId)
      links.push({
        id: `link-${featureId}-${anchorId}`,
        featureId,
        anchorId,
        status: 'active',
        reason: null,
        paragraphChecksum: paragraph ? paragraph.checksum : '',
        featureTextChecksum: checksum(feature?.text ?? ''),
        snapshot: null,
        review: null,
        createdAt: now,
        updatedAt: now
      })
    }
  }
  return links
}

export const initialAnnotations: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]
