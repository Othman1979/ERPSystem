import type { KeyboardEvent } from 'react';

/**
 * `onRow` props for a list table whose rows open a record (UI-05): the row
 * is reachable with Tab and opens on Enter or Space as well as on click.
 *
 *   <Table onRow={openableRow((r) => openDoc(r.id))} … />
 */
export function openableRow<T>(open: (record: T) => void) {
  return (record: T) => ({
    tabIndex: 0,
    className: 'row-openable',
    onClick: () => open(record),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // Only the row itself: Enter on a button or input inside the row is theirs.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(record);
      }
    },
  });
}
