# 23 · P5 App.tsx / styles.css 拆分

## 背景

当前 `apps/web/src/App.tsx` 约 6600 行，`styles.css` 约 6000 行。它们承载了聊天主界面、侧边栏、运行过程、Quick Compare、成本确认、附件、模型选择、错误恢复、图片预览等大量职责。继续把新能力塞进两个巨型文件，会显著拖慢后续记忆、RAG、导出、Markdown、诊断抽屉的迭代速度。

这不是工程洁癖，而是产品迭代速度问题：用户体验能力越多，越需要清晰边界。

## 用户价值

- **更快迭代**：后续新增诊断抽屉、导出、Markdown 增强时不容易误伤聊天主链路。
- **更少回归**：组件边界清晰后，测试能聚焦到具体体验。
- **更一致体验**：Quick Compare、普通消息、Timeline 等可复用同一渲染组件。

## 拆分原则

1. **先搬运，不重写**：第一阶段只移动代码，保持行为和 DOM testid 不变。
2. **按体验域拆分**：聊天、侧边栏、Timeline、成本、附件、错误恢复、Markdown 各自成块。
3. **样式跟组件走**：从单个 `styles.css` 逐步拆成 domain css，但保持最终在 `main.tsx` 统一 import。
4. **每步可验证**：每次拆分后跑 web typecheck 和相关 e2e。

## 推荐拆分顺序

1. `components/RunTimelinePanel.tsx`
2. `components/CostConfirmDialog.tsx` + `components/SessionCostPanel.tsx`
3. `components/AttachmentBar.tsx` + file drop helpers
4. `components/MarkdownView.tsx`
5. `components/ChatMessageList.tsx` / `MessageItem.tsx`
6. `components/Sidebar.tsx`
7. `hooks/useChatRuntime.ts`
8. `styles/{chat,timeline,cost,attachments,markdown}.css`

## 非目标

- 不在拆分阶段重做状态管理。
- 不引入新的 UI 框架。
- 不顺手改视觉样式。
- 不改变 API 合同。

## 验收

- 拆分后普通聊天、Quick Compare、Run Timeline、成本确认、附件上传、错误恢复 e2e 仍通过。
- `App.tsx` 降到可维护范围，目标首轮低于 3000 行。
- `styles.css` 首轮至少拆出 timeline/cost/attachments/markdown 样式。
