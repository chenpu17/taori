/**
 * Taori brand icon — two restrained threads woven through one knot.
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
      viewBox="0 0 32 32"
      role="img"
      aria-label={title}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <path
        d="M 6 10 C 10 10, 12 16, 16 16 C 20 16, 22 22, 26 22"
        stroke="var(--thread, #9B3D2F)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M 6 22 C 10 22, 12 16, 16 16 C 20 16, 22 10, 26 10"
        stroke="var(--mountain, #2C5F5D)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity="0.86"
      />
      <circle cx="16" cy="16" r="1.2" fill="var(--ink, #1A1612)" />
    </svg>
  );
}
