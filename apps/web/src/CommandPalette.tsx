import { useEffect, useMemo, useRef, useState } from 'react';
import type { Model, Provider } from '@taori/shared';
import { Icon, type IconName } from './Icon';
import type { Conversation } from './api';

interface CommandPaletteProps {
  models: Model[];
  providers: Provider[];
  conversations: Conversation[];
  activeModelId: string | null;
  streaming: boolean;
  currentTheme: 'light' | 'dark' | 'auto';
  onClose: () => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onSelectModel: (model: Model) => void;
  onOpenFeatures: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onStop: () => void;
}

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: IconName;
  keywords?: string;
  active?: boolean;
  run: () => void;
}

function providerName(model: Model, providers: Provider[]): string {
  return providers.find((provider) => provider.id === model.provider_id)?.name ?? model.provider_id ?? '';
}

function modelTitle(model: Model): string {
  return model.alias ?? model.display_name ?? model.model_name;
}

function matches(item: PaletteItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''} ${item.group}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const allItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: 'action-new',
        group: '操作',
        title: '新对话',
        subtitle: '清空当前并开始一段新的',
        icon: 'plus',
        keywords: 'new chat xindui 新建',
        run: props.onNewChat,
      },
      {
        id: 'action-features',
        group: '操作',
        title: '能力中心',
        subtitle: '快速对比 · 圆桌 · 深度研究',
        icon: 'bolt',
        keywords: 'feature compare roundtable research nengli',
        run: props.onOpenFeatures,
      },
      {
        id: 'action-settings',
        group: '操作',
        title: '设置',
        subtitle: '模型 · 服务商 · 外观',
        icon: 'settings',
        keywords: 'settings preference shezhi',
        run: props.onOpenSettings,
      },
      {
        id: 'action-theme',
        group: '操作',
        title: props.currentTheme === 'dark' ? '切换到浅色' : '切换到深色',
        subtitle: '换个心情',
        icon: props.currentTheme === 'dark' ? 'sun' : 'moon',
        keywords: 'theme dark light zhuti 主题 深色 浅色',
        run: props.onToggleTheme,
      },
    ];
    if (props.streaming) {
      actions.unshift({
        id: 'action-stop',
        group: '操作',
        title: '停止生成',
        subtitle: '中断当前正在输出的回复',
        icon: 'stop',
        keywords: 'stop cancel tingzhi 中断',
        run: props.onStop,
      });
    }

    const models: PaletteItem[] = props.models.map((model) => ({
      id: `model-${model.id}`,
      group: '切换模型',
      title: modelTitle(model),
      subtitle: `${providerName(model, props.providers)} · ${model.model_name}`,
      icon: 'panel',
      keywords: `${model.model_name} ${providerName(model, props.providers)} switch model qiehuan`,
      active: model.id === props.activeModelId,
      run: () => props.onSelectModel(model),
    }));

    const conversations: PaletteItem[] = props.conversations.map((conversation) => ({
      id: `convo-${conversation.id}`,
      group: '跳转对话',
      title: conversation.title || '未命名对话',
      subtitle: conversation.pinned ? '已固定' : undefined,
      icon: 'chat',
      keywords: 'conversation jump tiaozhuan 历史',
      run: () => props.onOpenConversation(conversation.id),
    }));

    return [...actions, ...models, ...conversations];
  }, [props]);

  const filtered = useMemo<PaletteItem[]>(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = allItems.filter((item) => matches(item, tokens));
    if (tokens.length > 0) {
      // when searching, keep it tight but global
      return all.slice(0, 40);
    }
    // default view: every action + a recent slice of models / conversations
    const actions = all.filter((item) => item.group === '操作');
    const models = all.filter((item) => item.group === '切换模型').slice(0, 6);
    const conversations = all.filter((item) => item.group === '跳转对话').slice(0, 6);
    return [...actions, ...models, ...conversations];
  }, [allItems, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${selected}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function runItem(item: PaletteItem | undefined): void {
    if (!item) return;
    item.run();
    props.onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, Math.max(0, filtered.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(filtered[selected]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    }
  }

  let lastGroup = '';

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="command-palette"
      >
        <div className="command-palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索命令、模型或对话…"
            aria-label="搜索命令、模型或对话"
            data-testid="command-palette-input"
          />
        </div>
        <div className="command-palette-list scroll" ref={listRef}>
          {filtered.length === 0 && <div className="command-palette-empty">没有匹配项</div>}
          {filtered.map((item, index) => {
            const showHeader = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showHeader && <div className="command-palette-group">{item.group}</div>}
                <button
                  type="button"
                  className={`command-palette-item${index === selected ? ' selected' : ''}`}
                  data-cmd-index={index}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => runItem(item)}
                  data-testid={`command-palette-item-${item.id}`}
                >
                  <span className="command-palette-icon">
                    <Icon name={item.icon} size={15} />
                  </span>
                  <span className="command-palette-text">
                    <span className="command-palette-title">{item.title}</span>
                    {item.subtitle && <span className="command-palette-sub">{item.subtitle}</span>}
                  </span>
                  {item.active && (
                    <span className="command-palette-active">
                      <Icon name="check" size={13} />
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="command-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
