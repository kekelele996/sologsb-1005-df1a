# 专利权利要求映射工作台

用于专利代理人与审查人员核对权利要求、技术特征和说明书支持依据的前端工作台。数据按案件本地保存，可恢复上次工作位置。

## 功能

- **两侧分离**：客户侧只持有说明书正文、段落编号与说明书版本；工作台侧只持有权利要求、技术特征、支持映射与批注。一侧的改动只落在自己这份。
- 录入独立/从属权利要求与说明书段落。
- 将权利要求拆分为技术特征，设置父级层级、特征间引用和负责角色。
- 技术特征通过**稳定段落锚点（anchorId）**映射说明书段落，编号变动不影响映射。
- **客户换版**：粘贴客户新稿 JSON 后先暂存并预览迁移计划（原样迁移 / 退回重核 / 挂起 / 重新激活），确认后才落新版本。
  - 新版没有对应锚点的映射**一律挂起**并保留旧段落快照，绝不指向新版不存在的段落，等待人工改指或放弃。
  - 段落换过而特征正文没动的支持关系**退回重核**，人工确认后恢复。
  - 换版失败时工作台映射回滚、客户旧稿保持可翻，可凭同一份暂存稿“按工作台这边重试”。
  - 历史说明书版本可随时只读翻阅。
- 自动提示引用循环、缺少依据、空特征、挂起/待重核映射和“特征已删除但映射未清理”。
- 角色切换与批注隔离：代理人、审查员只能修改本人批注，观察者只读。
- 工作台侧操作支持撤销重做，使用 `Ctrl/⌘ + Z` 与 `Ctrl/⌘ + Shift + Z`；撤销重做不影响客户侧版本。
- 保存权利要求/特征/映射快照，逐项比较正文差异并恢复历史版本。
- 导出完整 JSON 或可核对的 CSV，本地保存上次标签页、特征和滚动位置。
- 打开本机旧版数据（无说明书版本）时，**先迁移成两侧结构再启用**：旧段落归入客户侧第一版，旧的段落映射转成锚点映射。

## 客户新稿 JSON 格式

```json
{
  "name": "说明书 第2版",
  "baseVersionId": "spec-v-seed",
  "paragraphs": [
    { "anchorId": "anc-0012", "section": "说明书 [0013]", "number": 13, "text": "段落正文…" }
  ]
}
```

- `anchorId` 必填且在稿内唯一，用于跨版本匹配；`baseVersionId` 省略时以当前版本为基准。
- 仅改 `section/number`（重新编号）视为原样迁移；`text` 变化退回重核；新稿缺失的锚点挂起。
- 可参考 `docs/spec-draft-v2.sample.json`。

## 技术栈

- Angular 19、TypeScript、RxJS
- PrimeNG 19、PrimeIcons
- 浏览器 `localStorage`

## 本地开发

```bash
npm install
npm start
```

开发服务器监听容器内端口 4200，仅用于本地开发；项目不在源码中定义宿主端口。

## 生产构建

```bash
npm install
npm run build
```

产物位于 `dist/patent-claim-workbench/browser`。

## Docker

```bash
docker build -t sologsb-1005 .
docker run --rm -p 10005:80 sologsb-1005
```

nginx 在容器 80 端口提供构建产物，并按根端口表映射到宿主 `10005`。

## 数据说明

两侧数据分别保存在浏览器本地：客户侧 `patent-spec-client-side-v2`、工作台侧 `patent-workbench-side-v2`，互不覆盖。旧版单体数据键为 `patent-claim-mapping-workbench-v1`，首次打开 v2 时自动拆分迁移并清除。若需团队共享或长期归档，请在后续接入后端存储；当前实现为明确的前端离线原型。

## 端到端校验脚本

关键规则（两侧隔离、锚点迁移、挂起、退回重核、失败重试、旧数据迁移）由 `scripts/e2e.ts` 覆盖：

```bash
node_modules/.bin/esbuild scripts/e2e.ts --bundle --platform=node --format=cjs --outfile=scripts/e2e.bundle.cjs
node scripts/e2e.bundle.cjs
```
