import React, { Fragment, useMemo, useState, useRef, useEffect } from 'react';
import { EmptyState } from './EmptyState.js';
import { modelDisplayWithProvider } from './modelDisplay.js';

export interface Conversation {
  id: string;
  title: string | null;
  pinned?: boolean;
  tags?: string | null;
}

export interface Model {
  id: string;
  model_name: string;
  display_name: string;
  alias?: string | null;
  provider_id?: string | null;
  is_default_for?: string | null;
}

export interface Provider {
  id: string;
  name: string;
  type: string;
}

export interface CmdResult {
  id: string;
  category: 'conversation' | 'model' | 'settings' | 'help' | 'roundtable' | 'quick-compare' | 'research' | 'models-center' | 'costs';
  title: string;
  subtitle?: string;
  keywords?: string[];
  data?: any;
}

type CmdGroup = 'recent' | 'models' | 'actions';

interface CmdGroupedResult {
  group: CmdGroup;
  label: string;
  items: CmdResult[];
}

const CMD_CATEGORY_LABELS: Record<CmdResult['category'], string> = {
  conversation: '会话',
  model: '模型',
  settings: '设置',
  help: '帮助',
  roundtable: '圆桌',
  'quick-compare': '对比',
  research: '研究',
  'models-center': '模型中心',
  costs: '成本',
};

const FIXED_COMMANDS: CmdResult[] = [
  {
    id: 'costs',
    category: 'costs',
    title: '打开成本看板',
    subtitle: '查看预算、调用成本与模型花费',
    keywords: ['费用', '预算', '花费', '账单', 'cost', 'billing', 'spend'],
  },
  {
    id: 'models-center',
    category: 'models-center',
    title: '打开模型中心',
    subtitle: '管理供应商、模型、价格和默认模型',
    keywords: ['模型', '供应商', 'provider', 'api key', 'apikey', '价格', '默认模型'],
  },
  {
    id: 'settings',
    category: 'settings',
    title: '打开设置',
    subtitle: '调整预算、搜索、记忆、失败恢复等偏好',
    keywords: ['设置', '配置', '偏好', '搜索', '记忆', '失败恢复', 'settings'],
  },
  {
    id: 'roundtable',
    category: 'roundtable',
    title: '启动新圆桌',
    subtitle: '让多个模型围绕同一问题讨论与互评',
    keywords: ['圆桌', '多模型', '讨论', '辩论', '决策', 'roundtable'],
  },
  {
    id: 'quick-compare',
    category: 'quick-compare',
    title: '启动快速对比',
    subtitle: '并行比较 2-3 个模型回答并生成对比报告',
    keywords: ['快速对比', '对比', '比较', '评测', '选择模型', 'compare', 'eval'],
  },
  {
    id: 'research',
    category: 'research',
    title: '进入深度研究',
    subtitle: '自动规划、检索并整理结构化研究报告',
    keywords: ['研究', '检索', '报告', '资料', '调研', 'research'],
  },
  {
    id: 'help',
    category: 'help',
    title: '打开帮助',
    subtitle: '查看 FAQ、自检和真实 Provider 诊断',
    keywords: ['帮助', '指南', '文档', 'faq', '自检', '诊断', 'help'],
  },
];

function commandSearchText(command: CmdResult): string {
  return [
    command.title,
    command.subtitle,
    CMD_CATEGORY_LABELS[command.category],
    command.category,
    ...(command.keywords ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function conversationSearchText(conversation: Conversation): string {
  return [
    conversation.title ?? '',
    conversation.tags ?? '',
    conversation.pinned ? '置顶 pinned' : '',
  ].join(' ').toLowerCase();
}

function conversationSubtitle(conversation: Conversation): string | undefined {
  const parts = [
    conversation.pinned ? '置顶' : null,
    conversation.tags?.trim() ? conversation.tags.trim() : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectConv: (convId: string) => void;
  onSelectModel: (modelId: string) => void;
  onNavigate?: (path: string) => void;
  onOpenHelp?: () => void;
  onOpenRoundtable?: () => void;
  onOpenQuickCompare?: () => void;
  onOpenResearch?: () => void;
  conversations: Conversation[];
  models: Model[];
  providers: Provider[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSelectConv,
  onSelectModel,
  onNavigate,
  onOpenHelp,
  onOpenRoundtable,
  onOpenQuickCompare,
  onOpenResearch,
  conversations,
  models,
  providers,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [results, setResults] = useState<CmdResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const groupedResults = useMemo<CmdGroupedResult[]>(() => {
    const groups: CmdGroupedResult[] = [
      {
        group: 'recent',
        label: '最近会话',
        items: results.filter((result) => result.category === 'conversation'),
      },
      {
        group: 'models',
        label: '模型',
        items: results.filter((result) => result.category === 'model'),
      },
      {
        group: 'actions',
        label: '快捷操作',
        items: results.filter((result) => result.category !== 'conversation' && result.category !== 'model'),
      },
    ];
    return groups.filter((group) => group.items.length > 0);
  }, [results]);
  const displayResults = useMemo(
    () => groupedResults.flatMap((group) => group.items),
    [groupedResults],
  );

  // 搜索逻辑
  useEffect(() => {
    if (!query.trim()) {
      // 空查询时显示固定命令 + 最近会话
      const recentConvs = conversations.slice(0, 5).map(c => ({
        id: c.id,
        category: 'conversation' as const,
        title: c.title || '未命名对话',
        subtitle: conversationSubtitle(c),
      }));
      setResults([...recentConvs, ...FIXED_COMMANDS]);
      setSelectedIdx(0);
      return;
    }

    const q = query.toLowerCase();
    const hits: CmdResult[] = [];

    // 搜索会话
    conversations.forEach(c => {
      if (conversationSearchText(c).includes(q)) {
        hits.push({
          id: c.id,
          category: 'conversation',
          title: c.title || '未命名对话',
          subtitle: conversationSubtitle(c),
        });
      }
    });

    // 搜索模型
    models.forEach(m => {
      const label = modelDisplayWithProvider(m, providers);
      const text = `${label} ${m.model_name} ${m.alias ?? ''} ${m.provider_id || ''} ${m.is_default_for ? '默认 default' : ''}`.toLowerCase();
      if (text.includes(q)) {
        hits.push({
          id: m.id,
          category: 'model',
          title: label,
          subtitle: `${m.model_name}${m.is_default_for ? ' (默认)' : ''}`,
        });
      }
    });

    // 排序：精准匹配优先
    hits.sort((a, b) => {
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();
      if (aTitle.startsWith(q) && !bTitle.startsWith(q)) return -1;
      if (!aTitle.startsWith(q) && bTitle.startsWith(q)) return 1;
      return 0;
    });

    const matchingCommands = FIXED_COMMANDS
      .filter((command) => commandSearchText(command).includes(q))
      .sort((a, b) => {
        const aText = commandSearchText(a);
        const bText = commandSearchText(b);
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        if (aTitle.includes(q) && !bTitle.includes(q)) return -1;
        if (!aTitle.includes(q) && bTitle.includes(q)) return 1;
        if (aText.startsWith(q) && !bText.startsWith(q)) return -1;
        if (!aText.startsWith(q) && bText.startsWith(q)) return 1;
        return 0;
      });

    setResults([...hits.slice(0, 15), ...matchingCommands]);
    setSelectedIdx(0);
  }, [query, conversations, models, providers]);

  // 按键处理
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        if (displayResults.length === 0) return;
        e.preventDefault();
        setSelectedIdx(i => (i + 1) % displayResults.length);
      } else if (e.key === 'ArrowUp') {
        if (displayResults.length === 0) return;
        e.preventDefault();
        setSelectedIdx(i => (i - 1 + displayResults.length) % displayResults.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (displayResults[selectedIdx]) {
          handleSelect(displayResults[selectedIdx]);
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, displayResults, selectedIdx, onClose]);

  // 获得焦点
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQuery('');
    }
  }, [isOpen]);

  const handleSelect = (result: CmdResult) => {
    switch (result.category) {
      case 'conversation':
        onSelectConv(result.id);
        break;
      case 'model':
        onSelectModel(result.id);
        break;
      case 'settings':
        onNavigate?.('/settings');
        break;
      case 'costs':
        onNavigate?.('/costs');
        break;
      case 'help':
        onOpenHelp?.();
        break;
      case 'roundtable':
        onOpenRoundtable?.();
        break;
      case 'quick-compare':
        onOpenQuickCompare?.();
        break;
      case 'research':
        onOpenResearch?.();
        break;
      case 'models-center':
        onNavigate?.('/models');
        break;
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette-panel" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="cmd-palette-input"
          placeholder="搜索会话、模型、功能或设置..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          data-testid="cmd-palette-input"
        />
        <ul className="cmd-palette-results">
          {results.length === 0 ? (
            <li className="cmd-result-empty">
              <EmptyState
                title="没有匹配结果"
                hint="试试搜索会话标题、模型名，或输入设置 / 帮助 / 圆桌。"
                icon="⌘"
                compact
                tone="muted"
                testId="cmd-result-empty"
              />
            </li>
          ) : (
            groupedResults.map((group) => (
              <Fragment key={group.group}>
                <li className="cmd-group-header" role="presentation">
                  {group.label}
                </li>
                {group.items.map((result) => {
                  const idx = displayResults.findIndex((item) => item.id === result.id && item.category === result.category);
                  return (
                    <li
                      key={`${result.category}:${result.id}`}
                      className={`cmd-result ${idx === selectedIdx ? 'selected' : ''}`}
                      data-testid="cmd-result"
                      data-category={result.category}
                      onClick={() => handleSelect(result)}
                      onMouseEnter={() => setSelectedIdx(idx)}
                    >
                      <span className="cmd-category">{CMD_CATEGORY_LABELS[result.category]}</span>
                      <span className="cmd-result-copy">
                        <span className="cmd-title">{result.title}</span>
                        {result.subtitle && <span className="cmd-subtitle">{result.subtitle}</span>}
                      </span>
                    </li>
                  );
                })}
              </Fragment>
            ))
          )}
        </ul>
        <div className="cmd-palette-footer" aria-hidden="true">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
};
