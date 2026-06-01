import { Composer } from './Composer';
import { Icon, type IconName } from './Icon';
import type { FeatureTab } from './FeatureHub';
import type { ChatAttachment, Conversation } from './api';

interface SuggestionItem {
  icon: IconName;
  color: string;
  label: string;
  copy: string;
  action?: FeatureTab;
  actionLabel?: string;
}

const SUGGESTIONS: SuggestionItem[] = [
  { icon: 'pen', color: '#C26A4A', label: '写作', copy: '帮我写一封婉拒会议邀请的邮件' },
  { icon: 'book', color: '#7A8E6E', label: '解释', copy: '用三分钟解释什么是量子纠缠' },
  { icon: 'sparkle', color: '#C58B3A', label: '灵感', copy: '给我一份周末独处的好点子' },
  { icon: 'code', color: '#5A7BA8', label: '编程', copy: '把这段 JS 重构得更可读' },
  { icon: 'panel', color: '#8B6BAE', label: '多模型对比', copy: '把同一道难题交给 2-3 个模型并行作答，再帮我挑最好的', action: 'compare', actionLabel: '进入对比' },
  { icon: 'flame', color: '#B0594A', label: '深度研究', copy: '帮我做一份「桌面 AI 助手 2026 年市场趋势」的研究', action: 'research', actionLabel: '生成计划' },
];

interface EmptyStateProps {
  composer: string;
  onComposerChange: (value: string) => void;
  onSubmit: () => void;
  onPick: (copy: string) => void;
  streaming: boolean;
  disabled: boolean;
  modelLabel: string;
  onModelClick: () => void;
  attachments?: ChatAttachment[];
  onAttach?: (files: FileList) => void;
  onRemoveAttachment?: (index: number) => void;
  noModel: boolean;
  onConfigureProviders: () => void;
  recentConversation?: Conversation | null;
  onResumeConversation?: () => void;
  onOpenFeature?: (tab: FeatureTab, prompt?: string) => void;
}

function greetingText(): string {
  const hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  if (hour < 22) return '晚上好';
  return '夜深了';
}

function taskHint(value: string): { tab: FeatureTab; title: string; body: string; action: string } | null {
  const text = value.trim();
  if (text.length < 8) return null;
  if (/对比|比较|哪个好|取舍|优缺点|方案|选择/.test(text)) {
    return {
      tab: 'compare',
      title: '这像一个决策题',
      body: '适合让 2-3 个模型同时回答，再看速度、成本和观点差异。',
      action: '用快速对比',
    };
  }
  if (/研究|调研|报告|趋势|市场|资料|引用|来源/.test(text)) {
    return {
      tab: 'research',
      title: '这像一个研究任务',
      body: '先生成计划，再逐步执行、暂停、修订和导出报告。',
      action: '做深度研究',
    };
  }
  if (/决策|争议|评审|风险|共识|分歧|路线|优先级/.test(text)) {
    return {
      tab: 'roundtable',
      title: '这适合多模型圆桌',
      body: '让不同角色拆出共识、分歧、风险和下一步建议。',
      action: '开圆桌',
    };
  }
  return null;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const hint = taskHint(props.composer);
  return (
    <div className="empty scroll">
      <div className="empty-inner">
        <div className="greeting-glyph">织</div>
        <h1 className="greeting">{greetingText()}</h1>
        <p className="greeting-sub">
          <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            what&apos;s on your mind?
          </span>
        </p>

        {props.noModel && (
          <button
            type="button"
            className="cta-pill"
            onClick={props.onConfigureProviders}
            data-testid="empty-no-model-cta"
          >
            <span className="dot" />
            还没添加模型 — 30 秒接入第一个 →
          </button>
        )}
        {!props.noModel && props.recentConversation && props.onResumeConversation && (
          <button
            type="button"
            className="cta-pill"
            onClick={props.onResumeConversation}
            data-testid="empty-resume-recent"
          >
            <span className="dot" />
            继续上次的「{props.recentConversation.title || '未命名对话'}」 →
          </button>
        )}

        <Composer
          autoFocus
          large
          value={props.composer}
          onChange={props.onComposerChange}
          onSubmit={props.onSubmit}
          streaming={props.streaming}
          disabled={props.disabled}
          modelLabel={props.modelLabel}
          onModelClick={props.onModelClick}
          attachments={props.attachments}
          onAttach={props.onAttach}
          onRemoveAttachment={props.onRemoveAttachment}
          placeholder="问点什么，或粘贴一段文字开始…"
        />

        {hint && !props.noModel && (
          <div className="intent-hint" data-testid="empty-intent-hint">
            <div className="intent-hint-main">
              <span className="intent-dot" />
              <strong>{hint.title}</strong>
              <span>{hint.body}</span>
            </div>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => props.onOpenFeature?.(hint.tab, props.composer)}
            >
              {hint.action}
            </button>
          </div>
        )}

        <div
          className={`suggestions suggestions-three${props.noModel ? ' suggestions-dimmed' : ''}`}
          aria-hidden={props.noModel}
        >
          {SUGGESTIONS.map((s) => (
            <button
              type="button"
              key={s.label}
              className="suggest-card"
              disabled={props.noModel}
              onClick={() => {
                if (s.action) props.onOpenFeature?.(s.action, s.copy);
                else props.onPick(s.copy);
              }}
            >
              <span
                className="suggest-icon"
                style={{
                  background: `color-mix(in oklab, ${s.color} 14%, transparent)`,
                  color: s.color,
                }}
              >
                <Icon name={s.icon} size={15} />
              </span>
              <span>
                <div className="label" style={{ color: s.color }}>
                  {s.label}
                </div>
                <div className="copy">{s.copy}</div>
                {s.actionLabel && <div className="suggest-action">{s.actionLabel}</div>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
