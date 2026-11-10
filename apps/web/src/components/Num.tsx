import type { CSSProperties, ReactNode } from 'react';

/**
 * Wraps a formatted number in an isolated left-to-right run so a negative
 * value keeps its minus sign in front ("-200.000") inside Arabic (RTL) pages,
 * instead of the browser's bidi ordering moving it to the end ("200.000-").
 */
export function Num({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate', ...style }}>
      {children}
    </span>
  );
}
