import React, { useState } from 'react';

export interface DiscoverableTipContent {
  id: 'image' | 'fallback' | 'cost' | 'roundtable';
  icon: string;
  title: string;
  description: string;
  storageKey: string;
}

interface DiscoverableTipProps {
  content: DiscoverableTipContent;
  onDismiss: () => void;
}

export const DiscoverableTip: React.FC<DiscoverableTipProps> = ({ content, onDismiss }) => {
  const [fadeOut, setFadeOut] = useState(false);

  const handleDontShowAgain = () => {
    localStorage.setItem(content.storageKey, 'true');
    setFadeOut(true);
    setTimeout(onDismiss, 150);
  };

  const handleGotIt = () => {
    setFadeOut(true);
    setTimeout(onDismiss, 150);
  };

  return (
    <div className={`discoverable-tip ${fadeOut ? 'fade-out' : ''}`} data-testid={`tip-${content.id}`}>
      <div className="tip-overlay" onClick={handleGotIt}></div>
      <div className="tip-card">
        <div className="tip-kicker">发现新能力</div>
        <div className="tip-header">
          <span className="tip-icon">{content.icon}</span>
          <div className="tip-title-wrap">
            <span className="tip-title">{content.title}</span>
          </div>
        </div>
        <div className="tip-body">{content.description}</div>
        <div className="tip-footer">
          <button className="tip-btn tip-btn-primary" onClick={handleGotIt} data-testid="tip-got-it">
            知道了
          </button>
          <button className="tip-btn tip-btn-secondary" onClick={handleDontShowAgain} data-testid="tip-dont-show">
            别再提示
          </button>
        </div>
      </div>
    </div>
  );
};

// Helper to check if a tip should be shown
export const shouldShowTip = (storageKey: string): boolean => {
  return !localStorage.getItem(storageKey);
};

// Predefined tip contents
export const TIPS = {
  image: {
    id: 'image' as const,
    icon: '👁️',
    title: '多模型图像理解',
    description: '选择图片后，Taori 会自动用视觉能力强的模型分析。成本可在底部查看。',
    storageKey: 'tip_image_first_seen',
  },
  fallback: {
    id: 'fallback' as const,
    icon: '⚠️',
    title: '失败兜底',
    description: 'API 出错了？Taori 自动用备用模型重试。你也可以在「模型中心」调整降权规则。',
    storageKey: 'tip_fallback_first_seen',
  },
  cost: {
    id: 'cost' as const,
    icon: '💰',
    title: '成本透明',
    description: '这是本月已花的费用。在「成本看板」查看详细统计。设置→月度预算可以设上限和告警。',
    storageKey: 'tip_cost_first_seen',
  },
  roundtable: {
    id: 'roundtable' as const,
    icon: '🔍',
    title: '多模型圆桌',
    description: '在一次对话中同时让多个模型讨论同一问题，综合它们的观点。支持深度模式（渐进式提示）和快速模式（成本优化）。',
    storageKey: 'tip_roundtable_first_seen',
  },
};
