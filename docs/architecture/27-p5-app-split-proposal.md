# 27 · P5 App.tsx / styles.css 拆分架构提案

## 当前状态

代码规模：

```text
apps/web/src/App.tsx      ~6662 lines
apps/web/src/styles.css   ~6042 lines
```

`App.tsx` 当前包含：

- 数据类型与 annotation parser。
- Workspace、Sidebar、ChatPanel。
- Quick Compare UI。
- Run Timeline。
- Context snapshot。
- Cost confirm/session cost。
- Template picker/variables dialog。
- Capability preflight。
- Image picker/lightbox。
- Attachment bar。
- Model selector。
- Error/failure recovery card。

## 目标结构

```text
apps/web/src/
  app/
    App.tsx
    Workspace.tsx
    ChatPanel.tsx
    Sidebar.tsx
  chat/
    MessageItem.tsx
    ChatMessageList.tsx
    FailureDecisionCard.tsx
    CapabilityPreflight.tsx
  timeline/
    RunTimelinePanel.tsx
    ContextSnapshotCard.tsx
    runEventMeta.ts
  cost/
    CostConfirmDialog.tsx
    SessionCostPanel.tsx
    EstimateBar.tsx
  attachments/
    AttachmentBar.tsx
    fileDrop.ts
  markdown/
    MarkdownView.tsx
    render.ts
  quickCompare/
    QuickCompareResultCard.tsx
  styles/
    base.css
    layout.css
    chat.css
    timeline.css
    cost.css
    attachments.css
    markdown.css
```

## 执行策略

### Phase 1：无行为搬运

- 以现有函数边界为单位移动组件。
- 保留 props 透传，不先抽全局 store。
- 所有 `data-testid` 保持不变。
- CSS 只按 selector 分组剪切，不改样式值。

### Phase 2：抽 hooks

从 `ChatPanel` 中抽出：

- `useResumeRecovery`
- `useSlowResponseIntervention`
- `useQuickCompare`
- `useAttachments`
- `useCapabilityPreflight`

hooks 只封装状态与副作用，不直接渲染 UI。

### Phase 3：复用渲染组件

- 普通 assistant 消息和 Quick Compare 输出复用 `MarkdownView`。
- Run Timeline 独立接收 `events`、`focusTarget`、`onClose`。
- Cost 组件统一接收 budget/cost estimate props。

## 导入边界

- domain 组件允许依赖 `api.ts` types，但优先通过 props 接收数据。
- `App.tsx`/`ChatPanel.tsx` 保留 orchestration：加载会话、发送消息、stream 状态。
- 低层展示组件不得直接调用 `authedFetch`。

## 验证策略

每一阶段：

```bash
pnpm --filter @taori/web typecheck
pnpm --filter @taori/web test:e2e -- quick-compare.spec.ts
pnpm --filter @taori/web test:e2e -- r5-user-journey.spec.ts
```

按实际变更追加：

- Timeline 拆分：运行 run timeline 相关 e2e。
- Cost 拆分：运行 budget/cost confirm e2e。
- Attachments 拆分：运行 file/image upload e2e。

## 风险

- Prop drilling 短期会增加；首轮接受，第二阶段再抽 hooks。
- CSS selector 移动可能改变优先级；拆分时保持 import 顺序。
- 组件搬运容易漏掉 helper；优先选择无副作用展示组件开始。

## 完成标准

- `App.tsx` 不再承载 Timeline/Cost/Attachment/Markdown 的具体实现。
- 样式按 domain 拆分，`styles.css` 仅保留变量、reset 和过渡兼容层。
- 后续新增导出、Markdown、诊断抽屉无需继续修改巨型 `App.tsx` 主体。
