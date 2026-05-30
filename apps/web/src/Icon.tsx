import type { CSSProperties, ReactNode } from 'react';

type IconName =
  | 'plus'
  | 'search'
  | 'sparkle'
  | 'chat'
  | 'book'
  | 'folder'
  | 'archive'
  | 'sun'
  | 'moon'
  | 'settings'
  | 'chevron'
  | 'chevronDown'
  | 'paperclip'
  | 'mic'
  | 'image'
  | 'globe'
  | 'arrowUp'
  | 'send'
  | 'copy'
  | 'thumb'
  | 'refresh'
  | 'code'
  | 'doc'
  | 'close'
  | 'panel'
  | 'sidebarL'
  | 'more'
  | 'edit'
  | 'trash'
  | 'pin'
  | 'check'
  | 'flame'
  | 'pen'
  | 'palette'
  | 'bolt'
  | 'stop';

const PATHS: Record<IconName, ReactNode> = {
  plus: <path d="M10 4v12M4 10h12" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.5 13.5 3 3" />
    </>
  ),
  sparkle: <path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.5 5.5 7 7M13 13l1.5 1.5M14.5 5.5 13 7M7 13l-1.5 1.5" />,
  chat: <path d="M16.5 9.5c0 3.6-2.9 6.5-6.5 6.5-.9 0-1.8-.2-2.6-.5L4 17l1-3.4C4.4 12.5 4 11.1 4 9.5 4 5.9 6.9 3 10.5 3S17 5.9 17 9.5z" />,
  book: <path d="M4 4.5C4 4.2 4.2 4 4.5 4H9c1.1 0 2 .9 2 2v10c0-1.1-.9-2-2-2H4.5c-.3 0-.5-.2-.5-.5V4.5zM16 4.5c0-.3-.2-.5-.5-.5H11c-1.1 0-2 .9-2 2v10c0-1.1.9-2 2-2h4.5c.3 0 .5-.2.5-.5V4.5z" />,
  folder: <path d="M3 6c0-.6.4-1 1-1h3.5l1.5 2h7c.6 0 1 .4 1 1v7c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V6z" />,
  archive: <path d="M3 6h14M4 6v9c0 .6.4 1 1 1h10c.6 0 1-.4 1-1V6M5 6V4c0-.6.4-1 1-1h8c.6 0 1 .4 1 1v2M8 10h4" />,
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M4.7 15.3l1.1-1.1M14.2 5.8l1.1-1.1" />
    </>
  ),
  moon: <path d="M16 11.5A6.5 6.5 0 0 1 8.5 4a.5.5 0 0 0-.7-.5A7 7 0 1 0 16.5 12a.5.5 0 0 0-.5-.5z" />,
  settings: (
    <>
      <circle cx="10" cy="10" r="2.2" />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" />
    </>
  ),
  chevron: <path d="m7 5 5 5-5 5" />,
  chevronDown: <path d="m5 8 5 5 5-5" />,
  paperclip: <path d="M14 8.5 9.4 13.1a2.5 2.5 0 0 1-3.5-3.5L11 4.5a4 4 0 0 1 5.7 5.7l-5.7 5.7" />,
  mic: (
    <>
      <rect x="8" y="3" width="4" height="9" rx="2" />
      <path d="M5.5 9.5a4.5 4.5 0 0 0 9 0M10 14.5V17" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.2" />
      <path d="m3.5 14 4-4 3 3 3-2 3 3" />
    </>
  ),
  globe: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2.3 3 5 3 7s-1 4.7-3 7c-2-2.3-3-5-3-7s1-4.7 3-7z" />
    </>
  ),
  arrowUp: <path d="M10 16V4M5 9l5-5 5 5" />,
  send: <path d="M16 4 9 11M16 4l-5 12-2-5-5-2 12-5z" />,
  copy: (
    <>
      <rect x="6" y="6" width="9" height="9" rx="1.5" />
      <path d="M5 12V5.5C5 5.2 5.2 5 5.5 5H12" />
    </>
  ),
  thumb: <path d="M3 9.5h2v6H3zM5 9.5l3-6c1.5 0 2.5 1 2.5 2.5V8H15c1 0 1.7.8 1.5 1.8l-1 5c-.2.8-.9 1.2-1.6 1.2H5" />,
  refresh: <path d="M4 10a6 6 0 0 1 10-4.5M16 10a6 6 0 0 1-10 4.5M14 3v3h-3M6 17v-3h3" />,
  code: <path d="m7 6-4 4 4 4M13 6l4 4-4 4" />,
  doc: (
    <>
      <path d="M5 3h6l4 4v9c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1z" />
      <path d="M11 3v3c0 .6.4 1 1 1h3" />
    </>
  ),
  close: <path d="m5 5 10 10M15 5 5 15" />,
  panel: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M12 4v12" />
    </>
  ),
  sidebarL: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M8 4v12" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="10" r="1.2" />
      <circle cx="10" cy="10" r="1.2" />
      <circle cx="15" cy="10" r="1.2" />
    </>
  ),
  edit: <path d="M13 4l3 3-8.5 8.5L4 16l.5-3.5L13 4z" />,
  trash: <path d="M4 6h12M8 6V4.5c0-.3.2-.5.5-.5h3c.3 0 .5.2.5.5V6M6 6l.5 9c0 .6.5 1 1 1h5c.5 0 1-.4 1-1L14 6" />,
  pin: <path d="m10 3-2 4-3 .5 2.5 2L7 13l3-2 3 2-.5-3.5 2.5-2-3-.5L10 3z" style={{ transform: 'rotate(45deg)', transformOrigin: 'center' }} />,
  check: <path d="m4 10 4 4 8-9" />,
  flame: <path d="M10 17c-3 0-5-2-5-5 0-3 3-4 3-7 2 1 4 4 4 6 0-1 1-2 2-3 1 2 2 3 2 5 0 3-3 4-6 4z" />,
  pen: <path d="M3 17l3-1L16 6l-2-2L4 14l-1 3z" />,
  palette: (
    <>
      <path d="M10 3a7 7 0 0 0 0 14c1 0 1.5-.7 1.5-1.5 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H14a3 3 0 0 0 3-3 7 7 0 0 0-7-7z" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="9" cy="6" r="1" />
      <circle cx="13" cy="6.5" r="1" />
    </>
  ),
  bolt: <path d="m11 3-7 9h5l-1 5 7-9h-5l1-5z" />,
  stop: <rect x="5" y="5" width="10" height="10" rx="1.5" />,
};

interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  style?: CSSProperties;
  className?: string;
}

export function Icon({ name, size = 16, stroke = 1.6, style, className }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: size, height: size, ...style }}
      className={className}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

export type { IconName };
