/**
 * Taori brand icon — three woven threads (indigo → violet → teal) tying
 * into a single node. Symbolizes "weaving many models into one continuous
 * flow". Pure SVG so it crisp-renders at any size.
 */
import type { JSX } from 'react';

export function TaoriIcon({
  size = 32,
  className,
  title = 'Taori',
}: {
  size?: number;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <linearGradient id="taori-thread-1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="taori-thread-2" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
        <linearGradient id="taori-thread-3" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
        <radialGradient id="taori-node" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#c4b5fd" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Three threads weaving through a central node */}
      <path
        d="M6 18 C 18 18, 22 32, 32 32 S 46 46, 58 46"
        stroke="url(#taori-thread-1)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 32 C 18 32, 22 32, 32 32 S 46 32, 58 32"
        stroke="url(#taori-thread-2)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 46 C 18 46, 22 32, 32 32 S 46 18, 58 18"
        stroke="url(#taori-thread-3)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />

      {/* The central knot — soft glow + solid core */}
      <circle cx="32" cy="32" r="10" fill="url(#taori-node)" />
      <circle cx="32" cy="32" r="4.5" fill="#ffffff" />
      <circle cx="32" cy="32" r="2.4" fill="#6366f1" />
    </svg>
  );
}
