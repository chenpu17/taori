import type { ReactNode } from 'react';

export function EmptyState({
  title,
  hint,
  icon = '✦',
  compact = false,
  tone = 'brand',
  className = '',
  children,
  testId,
}: {
  title: string;
  hint?: string;
  icon?: string;
  compact?: boolean;
  tone?: 'brand' | 'muted' | 'warn';
  className?: string;
  children?: ReactNode;
  testId?: string;
}): JSX.Element {
  const classes = [
    'empty-state',
    compact ? 'empty-state--compact' : '',
    `empty-state--${tone}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-testid={testId}>
      <span className="empty-state__art" aria-hidden="true">
        {icon}
      </span>
      <div className="empty-state__body">
        <strong className="empty-state__title">{title}</strong>
        {hint ? <span className="empty-state__hint">{hint}</span> : null}
      </div>
      {children ? <div className="empty-state__actions">{children}</div> : null}
    </div>
  );
}
