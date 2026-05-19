/**
 * Taori brand icon — a restrained woven thread mark.
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
        d="M 8 22 C 12 18, 16 14, 20 10 C 22 8.5, 24 8.5, 25 10 C 25.5 11, 24.5 12, 22.5 12 C 18 12, 14 14, 10 18"
        stroke="var(--thread, #9B3D2F)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
