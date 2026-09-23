import type { KeyboardEvent, ReactNode } from "react";

interface RowProps {
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** Double-click or Enter: the row's main action. */
  readonly onActivate: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A table row that selects on click and acts on double-click, like a native list
 * view, and does the same from the keyboard: Tab to it, Enter to act.
 */
export function Row({ selected, onSelect, onActivate, className, children }: RowProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onActivate();
    }
  };
  const classes = [className, selected ? "selected" : undefined].filter(Boolean).join(" ");
  return (
    <tr
      className={classes || undefined}
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onFocus={onSelect}
      onDoubleClick={onActivate}
      onKeyDown={onKeyDown}
    >
      {children}
    </tr>
  );
}
