import type { ReactNode } from 'react';
import type { ModelId } from './primitives';

// ── Modes (composer +) ───────────────────────────────────────
export type ModeId = 'roundtable' | 'research' | 'compare' | 'image' | 'file';

export const MODES: Record<ModeId, { name: string; icon: 'roundtable' | 'research' | 'compare' | 'image' | 'attach'; desc: string; kbd: string }> = {
  roundtable: { name: '开圆桌', icon: 'roundtable', desc: '让 3 个模型一起讨论', kbd: '/roundtable' },
  research: { name: '做研究', icon: 'research', desc: '多轮搜索 + 综述', kbd: '/research' },
  compare: { name: '对比', icon: 'compare', desc: '并排看 2-3 个模型回答', kbd: '/compare' },
  image: { name: '生图', icon: 'image', desc: '调用图像模型', kbd: '/image' },
  file: { name: '附件', icon: 'attach', desc: '也可以直接拖文件', kbd: '/file' },
};

// ── Message kinds ────────────────────────────────────────────
export type Message =
  | { kind: 'user'; body: ReactNode }
  | {
      kind: 'assistant';
      model: ModelId;
      time: string;
      cost: string;
      tokensIn?: number;
      tokensOut?: number;
      body: ReactNode;
      fallback?: { from: string; to: string; reason: string };
    }
  | {
      kind: 'roundtable';
      status: 'streaming' | 'done';
      totalCost?: string;
      rows: { model: ModelId; time: string; cost: string; tag?: '倾向 A' | '倾向 B'; content: ReactNode }[];
    }
  | {
      kind: 'research-progress';
      progress: number;
      iter: string;
      sources: number;
      papers: number;
      cost: string;
      now: ReactNode;
    }
  | {
      kind: 'research-done';
      title: string;
      summary: ReactNode;
      citations: number;
      cost: string;
    }
  | {
      kind: 'compare';
      cols: { model: ModelId; content: ReactNode; time: string; cost: string }[];
      picked?: ModelId;
    }
  | {
      kind: 'image';
      model: ModelId;
      cost: string;
    };

export interface Scenario {
  label: string;
  sidebarTitle?: string;
  sidebarKind?: 'roundtable' | 'research' | 'image' | 'chat';
  welcome?: boolean;
  noKey?: boolean;
  messages: Message[];
}

export type ScenarioId = 'empty' | 'nokey' | 'pricing' | 'research' | 'researchDone' | 'resume' | 'opening' | 'poster';

// ── Scenario data ────────────────────────────────────────────
export const SCENARIOS: Record<ScenarioId, Scenario> = {
  empty: { label: '空状态 / 首屏', messages: [], welcome: true },
  nokey: { label: '首次无 Key', messages: [], welcome: true, noKey: true },

  pricing: {
    label: '圆桌 · 定价讨论',
    sidebarTitle: '定价讨论',
    sidebarKind: 'roundtable',
    messages: [
      { kind: 'user', body: '我们 SaaS 工具的定价方案怎么定？三个档位？按订阅 vs 按量？目标是开发者用户。' },
      {
        kind: 'roundtable',
        status: 'done',
        totalCost: '0.07',
        rows: [
          {
            model: 'sonnet', time: '0.8s', cost: '0.020', tag: '倾向 A',
            content: (
              <>
                建议 <strong>三档订阅 + 免费层</strong>：Free (¥0)、Pro (¥69/月)、Team (¥299/月)。开发者对订阅模型更熟，可预测的成本结构是关键。免费层做引流，Pro 做主销，Team 做扩展。
              </>
            ),
          },
          {
            model: 'gpt4o', time: '1.1s', cost: '0.038', tag: '倾向 B',
            content: (
              <>
                建议 <strong>按 API 调用量 + 套餐封顶</strong>：¥0.01/次起步，套餐 ¥39/月封顶 1万次。开发者讨厌"用不到的订阅"，按量更公平。可以保留 Team 套餐做企业。
              </>
            ),
          },
          {
            model: 'deepseek', time: '0.6s', cost: '0.012', tag: '倾向 A',
            content: (
              <>
                同意三档订阅，但更激进：免费层完全够日常，付费层应该给 <strong>显著的能力差距</strong>（更长 context、并发、Roundtable），而不是单纯按量限制。否则开发者会自建。
              </>
            ),
          },
        ],
      },
    ],
  },

  research: {
    label: '研究 · AI 编辑器市场',
    sidebarTitle: '研究 · AI 编辑器市场',
    sidebarKind: 'research',
    messages: [
      { kind: 'user', body: '研究下 2026 年 AI 编辑器市场，主要玩家、定价、竞争格局。给我一份能拿去开会的综述。' },
      {
        kind: 'research-progress',
        progress: 56,
        iter: '2/4',
        sources: 12,
        papers: 5,
        cost: '0.31',
        now: <>交叉验证三家（Cursor / Zed / Windsurf）2026 Q2 定价</>,
      },
    ],
  },

  researchDone: {
    label: '研究 · 已完成',
    sidebarTitle: '研究 · AI 编辑器市场',
    sidebarKind: 'research',
    messages: [
      { kind: 'user', body: '研究下 2026 年 AI 编辑器市场，主要玩家、定价、竞争格局。给我一份能拿去开会的综述。' },
      {
        kind: 'research-done',
        title: '2026 年 AI 编辑器市场综述',
        summary: (
          <>
            市场已从"AI 补全"分化为三条路线：基于 VSCode 的 Cursor / Windsurf（覆盖 80% 装机量但功能同质化），原生 Rust 编辑器 Zed（性能差异化、活跃用户 +180% YoY），以及 IDE 内嵌如 JetBrains AI Assistant。定价上 Pro 档位从 2024 年 $20 普遍下探至 $15，但提供了更激进的 Roundtable 与 Agent 能力。
            <br />
            <br />
            关键变量是 <strong>本地模型</strong>（Llama 3.3 / DeepSeek Coder）在 2026 H1 拉平了云端付费档的常用任务，这压制了云端订阅 ARPU。
          </>
        ),
        citations: 12,
        cost: '0.92',
      },
    ],
  },

  resume: {
    label: '失败兜底 · 改简历',
    sidebarTitle: '改简历',
    sidebarKind: 'chat',
    messages: [
      { kind: 'user', body: '帮我把这段简历改得更适合资深产品岗，语气克制点。' },
      {
        kind: 'assistant',
        model: 'gpt4o',
        time: '0.9s',
        cost: '0.030',
        tokensIn: 412,
        tokensOut: 884,
        body: (
          <>
            <p>已经按"资深产品岗 + 克制语气"重写，主要改了三点：</p>
            <ul>
              <li>把 <strong>"主导/打造/驱动"</strong> 这类强动词换成 <strong>"参与设计/牵头评估/落地"</strong>，弱化个人英雄主义。</li>
              <li>所有结果都加了 <strong>具体数字与时间窗</strong>（Q3 留存 +12%、上线 6 周内日活破 5 万）。</li>
              <li>删掉了三段"我的核心理念"类自述，改用客观的项目段落承担表达。</li>
            </ul>
            <p>需要我再调成"略带温度"的版本对比一下吗？</p>
          </>
        ),
        fallback: { from: 'Sonnet', to: 'GPT-4o', reason: '限流（429）' },
      },
    ],
  },

  opening: {
    label: '对比 · 写开场白',
    sidebarTitle: '产品发布开场白',
    sidebarKind: 'chat',
    messages: [
      { kind: 'user', body: '给我写一句产品发布的开场白，2026 春季，AI 助手类产品，克制不浮夸。' },
      {
        kind: 'compare',
        cols: [
          { model: 'sonnet', content: '今年春天，我们不打算再发明一个会"懂你"的助手。我们只想让你手边已经在用的几个模型，终于能在一条对话里好好配合。', time: '1.1s', cost: '0.024' },
          { model: 'gpt4o', content: '过去两年的 AI 让我们意识到一件事：模型越多，切换越累。今天我们发布的不是新模型，而是一个能让所有模型为你一个人工作的容器。', time: '0.9s', cost: '0.038' },
          { model: 'deepseek', content: '一个模型不够用，十个模型用不过来。Taori 0.6 想解决的就是这件简单的事：把它们变成一条不断的对话。', time: '0.7s', cost: '0.011' },
        ],
      },
    ],
  },

  poster: {
    label: '生图 · 海报',
    sidebarTitle: '海报草稿',
    sidebarKind: 'image',
    messages: [
      { kind: 'user', body: '画一张赛博朋克咖啡店海报，夜景，霓虹灯，有点 80s vintage 的感觉。' },
      { kind: 'image', model: 'dalle', cost: '0.16' },
    ],
  },
};

// ── Sidebar groups (for the redesigned sidebar) ──────────────
export interface SidebarItem {
  id: ScenarioId | string;
  title: string;
  kind: 'roundtable' | 'research' | 'image' | 'chat';
}

export interface SidebarGroup {
  date: string;
  list: SidebarItem[];
}

export const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    date: '今天',
    list: [
      { id: 'pricing', title: '定价讨论', kind: 'roundtable' },
      { id: 'resume', title: '改简历', kind: 'chat' },
      { id: 'opening', title: '产品发布开场白', kind: 'chat' },
    ],
  },
  {
    date: '昨天',
    list: [
      { id: 'poster', title: '海报草稿', kind: 'image' },
      { id: 'researchDone', title: 'AI 编辑器市场综述', kind: 'research' },
    ],
  },
  {
    date: '本周',
    list: [
      { id: 'research', title: 'AI 编辑器市场', kind: 'research' },
      { id: 'lit', title: '产品文案 v3', kind: 'chat' },
      { id: 'sql', title: 'SQL 调优 · 窗口函数', kind: 'chat' },
      { id: 'fr', title: '法语翻译 · 邮件', kind: 'chat' },
    ],
  },
  {
    date: '更早',
    list: [
      { id: 'arch', title: '后端架构 review', kind: 'roundtable' },
      { id: 'meet', title: '上周会议纪要', kind: 'chat' },
    ],
  },
];
