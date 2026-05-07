export function StatusNotice({
  tone = 'info',
  title,
  detail,
  compact = false,
  testId,
}: {
  tone?: 'info' | 'loading' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
  compact?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <div
      className={`status-notice status-notice--${tone}${compact ? ' status-notice--compact' : ''}`}
      data-testid={testId}
      role={tone === 'error' || tone === 'warn' ? 'alert' : undefined}
      aria-live={tone === 'loading' ? 'polite' : undefined}
    >
      <span className="status-notice__icon" aria-hidden="true">
        {tone === 'loading' ? <span className="status-notice__spinner" /> : null}
      </span>
      <div className="status-notice__body">
        <strong className="status-notice__title">{title}</strong>
        {detail ? <span className="status-notice__detail">{detail}</span> : null}
      </div>
    </div>
  );
}
