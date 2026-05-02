import React, { useState, useRef, useEffect } from 'react';
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
  category: 'conversation' | 'model' | 'settings' | 'help' | 'roundtable' | 'models-center' | 'costs';
  title: string;
  subtitle?: string;
  data?: any;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectConv: (convId: string) => void;
  onSelectModel: (modelId: string) => void;
  onNavigate?: (path: string) => void;
  onOpenHelp?: () => void;
  onOpenRoundtable?: () => void;
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
  conversations,
  models,
  providers,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [results, setResults] = useState<CmdResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // 搜索逻辑
  useEffect(() => {
    if (!query.trim()) {
      // 空查询时显示固定命令 + 最近会话
      const fixed: CmdResult[] = [
        { id: 'costs', category: 'costs', title: '打开成本看板' },
        { id: 'models-center', category: 'models-center', title: '打开模型中心' },
        { id: 'settings', category: 'settings', title: '打开设置' },
        { id: 'roundtable', category: 'roundtable', title: '启动新圆桌' },
        { id: 'help', category: 'help', title: '打开帮助' },
      ];
      const recentConvs = conversations.slice(0, 5).map(c => ({
        id: c.id,
        category: 'conversation' as const,
        title: c.title || '未命名对话',
        subtitle: c.pinned ? '📌 置顶' : undefined,
      }));
      setResults([...recentConvs, ...fixed]);
      setSelectedIdx(0);
      return;
    }

    const q = query.toLowerCase();
    const hits: CmdResult[] = [];

    // 搜索会话
    conversations.forEach(c => {
      if ((c.title || '').toLowerCase().includes(q)) {
        hits.push({
          id: c.id,
          category: 'conversation',
          title: c.title || '未命名对话',
          subtitle: c.pinned ? '📌 置顶' : undefined,
        });
      }
    });

    // 搜索模型
    models.forEach(m => {
      const label = modelDisplayWithProvider(m, providers);
      const text = `${label} ${m.model_name} ${m.provider_id || ''}`.toLowerCase();
      if (text.includes(q)) {
        hits.push({
          id: m.id,
          category: 'model',
          title: label,
          subtitle: `${m.model_name}${m.is_default_for ? ' (默认)' : ''}`,
        });
      }
    });

    // 固定命令（如果不是空查询）
    const fixedCommands: CmdResult[] = [
      { id: 'costs', category: 'costs', title: '打开成本看板' },
      { id: 'models-center', category: 'models-center', title: '打开模型中心' },
      { id: 'settings', category: 'settings', title: '打开设置' },
      { id: 'roundtable', category: 'roundtable', title: '启动新圆桌' },
      { id: 'help', category: 'help', title: '打开帮助' },
    ];

    // 排序：精准匹配优先
    hits.sort((a, b) => {
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();
      if (aTitle.startsWith(q) && !bTitle.startsWith(q)) return -1;
      if (!aTitle.startsWith(q) && bTitle.startsWith(q)) return 1;
      return 0;
    });

    setResults([...hits.slice(0, 15), ...fixedCommands]);
    setSelectedIdx(0);
  }, [query, conversations, models, providers]);

  // 按键处理
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(i => (i + 1) % results.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(i => (i - 1 + results.length) % results.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results[selectedIdx]) {
          handleSelect(results[selectedIdx]);
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, results, selectedIdx, onClose]);

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
          placeholder="搜索会话、模型、设置..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          data-testid="cmd-palette-input"
        />
        <ul className="cmd-palette-results">
          {results.map((result, idx) => (
            <li
              key={result.id}
              className={`cmd-result ${idx === selectedIdx ? 'selected' : ''}`}
              data-testid="cmd-result"
              data-category={result.category}
              onClick={() => handleSelect(result)}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span className="cmd-category">{result.category}</span>
              <span className="cmd-title">{result.title}</span>
              {result.subtitle && <span className="cmd-subtitle">{result.subtitle}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
