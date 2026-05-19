/**
 * Taori UI icon set — small line SVGs that match the Taori paper-and-ink
 * design language. 1.4px stroke, 16px viewBox, currentColor.
 *
 * Keep this file flat: every icon is a JSX-returning function so that bundlers
 * can dead-code-eliminate unused glyphs.
 */
import type { JSX } from 'react';

export type IconName =
  | 'plus'
  | 'search'
  | 'send'
  | 'arrow-up'
  | 'settings'
  | 'cost'
  | 'model'
  | 'help'
  | 'cmd'
  | 'shield'
  | 'paperclip'
  | 'web'
  | 'image'
  | 'chevron-down'
  | 'copy'
  | 'refresh'
  | 'check'
  | 'spark'
  | 'thread'
  | 'pin'
  | 'tools'
  | 'stop'
  | 'theme'
  | 'sun'
  | 'moon'
  | 'system'
  | 'check-square'
  | 'dots';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
  strokeWidth?: number;
}

export function Icon({
  name,
  size = 16,
  className,
  title,
  strokeWidth = 1.4,
}: IconProps): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': title ? undefined : (true as const),
    role: title ? ('img' as const) : undefined,
  };

  return (
    <svg {...common}>
      {title ? <title>{title}</title> : null}
      {renderPaths(name)}
    </svg>
  );
}

function renderPaths(name: IconName): JSX.Element | null {
  switch (name) {
    case 'plus':
      return <path d="M8 3.5v9M3.5 8h9" />;
    case 'search':
      return (
        <>
          <circle cx="7" cy="7" r="4.5" />
          <path d="m13 13-2.5-2.5" />
        </>
      );
    case 'send':
      return <path d="M3 8 L13 8 M9 4 L13 8 L9 12" />;
    case 'arrow-up':
      return <path d="M8 13V3M4 7l4-4 4 4" />;
    case 'settings':
      return (
        <>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
        </>
      );
    case 'cost':
      return <path d="M8 1v14M11.5 4H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H4" />;
    case 'model':
      return (
        <>
          <circle cx="4" cy="4" r="1.5" />
          <circle cx="12" cy="4" r="1.5" />
          <circle cx="4" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <path d="M5.5 4h5M5.5 12h5M4 5.5v5M12 5.5v5" />
        </>
      );
    case 'help':
      return (
        <>
          <circle cx="8" cy="8" r="6.5" />
          <path d="M6.3 6a1.7 1.7 0 1 1 2.7 1.4c-.6.4-1 .8-1 1.6M8 11.2v.05" />
        </>
      );
    case 'cmd':
      return (
        <path d="M5 4.5A1.5 1.5 0 1 1 6.5 6H5m6 0a1.5 1.5 0 1 1-1.5-1.5V6M5 9.5A1.5 1.5 0 1 0 6.5 8H5m6 0a1.5 1.5 0 1 0-1.5 1.5V8" />
      );
    case 'shield':
      return <path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4l-5-2zM6 8l1.5 1.5L10.5 6" />;
    case 'paperclip':
      return <path d="M11.5 6.5 7 11a2.5 2.5 0 0 1-3.5-3.5l5-5a1.7 1.7 0 0 1 2.4 2.4L6 9.5" />;
    case 'web':
      return (
        <>
          <circle cx="8" cy="8" r="6.5" />
          <path d="M1.5 8h13M8 1.5c1.8 2 2.7 4 2.7 6.5S9.8 12.5 8 14.5C6.2 12.5 5.3 10.5 5.3 8S6.2 3.5 8 1.5z" />
        </>
      );
    case 'image':
      return (
        <>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <circle cx="6" cy="6.5" r="1" />
          <path d="m2.5 11 3-3 3 3 2-2 3 3" />
        </>
      );
    case 'chevron-down':
      return <path d="m4 6 4 4 4-4" />;
    case 'copy':
      return (
        <>
          <rect x="5" y="5" width="8" height="8" rx="1.5" />
          <path d="M3 11V4a1 1 0 0 1 1-1h7" />
        </>
      );
    case 'refresh':
      return <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />;
    case 'check':
      return <path d="m3.5 8 3 3 6-6" />;
    case 'spark':
      return <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2 2M9.8 9.8l2 2M4.2 11.8l2-2M9.8 6.2l2-2" />;
    case 'thread':
      return <path d="M2 5c2 0 3 3 6 3s4-3 6-3M2 11c2 0 3-3 6-3s4 3 6 3" />;
    case 'pin':
      return <path d="M8 1.5v5M5 6.5h6L9.5 9v3l-1.5 1.5L6.5 12V9L5 6.5z" />;
    case 'tools':
      return <path d="M11 4l3-3 1 1-3 3M11 4l-3 3-3-3 3-3 3 3zM5 8l3 3-3.5 3.5L1 11 4.5 7.5" />;
    case 'stop':
      return <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" />;
    case 'theme':
      return <path d="M8 2a6 6 0 1 0 6 6c0-.3 0-.6-.1-.9A4 4 0 0 1 8.1 2z" />;
    case 'sun':
      return (
        <>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" />
        </>
      );
    case 'moon':
      return <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />;
    case 'system':
      return (
        <>
          <rect x="2" y="3" width="12" height="8" rx="1.5" />
          <path d="M5.5 13.5h5M8 11v2.5" />
        </>
      );
    case 'check-square':
      return (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="m5.5 8 2 2 3.5-4" />
        </>
      );
    case 'dots':
      return (
        <>
          <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
        </>
      );
    default:
      return null;
  }
}
