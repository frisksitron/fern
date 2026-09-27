/**
 * In-app replacements for `prompt()` and `confirm()`, drawn by `Dialogs.svelte` in the root layout.
 * One dialog shows at a time; asking again answers the previous one as cancelled.
 */
type Request =
  | {
      readonly kind: 'text';
      readonly title: string;
      readonly label: string;
      readonly value: string;
      readonly maxLength: number;
      readonly confirmLabel: string;
      readonly resolve: (value: string | null) => void;
    }
  | {
      readonly kind: 'confirm';
      readonly title: string;
      readonly message: string;
      readonly confirmLabel: string;
      readonly danger: boolean;
      readonly resolve: (value: boolean) => void;
    };

export const dialogs = $state<{ current: Request | null }>({ current: null });

function cancelCurrent() {
  const current = dialogs.current;
  if (!current) return;
  dialogs.current = null;
  if (current.kind === 'text') current.resolve(null);
  else current.resolve(false);
}

/** Asks for a short text, such as a name. Resolves to the trimmed text, or null when cancelled. */
export function askText(options: {
  title: string;
  label: string;
  value?: string;
  maxLength?: number;
  confirmLabel?: string;
}): Promise<string | null> {
  cancelCurrent();
  return new Promise((resolve) => {
    dialogs.current = {
      kind: 'text',
      value: '',
      maxLength: 80,
      confirmLabel: 'Save',
      ...options,
      resolve: (value) => resolve(value === null ? null : value.trim() || null),
    };
  });
}

/** Asks to confirm an action. Resolves to true when confirmed. */
export function askConfirm(options: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  cancelCurrent();
  return new Promise((resolve) => {
    dialogs.current = { kind: 'confirm', danger: false, ...options, resolve };
  });
}

/** Answers the open dialog. */
export function answer(value: string | boolean | null) {
  const current = dialogs.current;
  if (!current) return;
  dialogs.current = null;
  if (current.kind === 'text') current.resolve(typeof value === 'string' ? value : null);
  else current.resolve(value === true);
}
