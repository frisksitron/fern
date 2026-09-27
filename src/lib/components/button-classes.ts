import type { ClassValue } from 'svelte/elements';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'small' | 'medium';

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'medium',
  className?: ClassValue | null,
) {
  return [
    'inline-flex cursor-pointer items-center justify-center border-0 font-semibold no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:pointer-events-none disabled:opacity-45',
    size === 'small' ? 'min-h-10 px-3 text-sm' : 'min-h-11 px-5 text-sm',
    variant === 'primary' && 'bg-fern-accent text-white hover:bg-[#d9470d]',
    variant === 'secondary' && 'bg-black text-white hover:bg-[#414141]',
    variant === 'ghost' && 'bg-transparent text-[#414141] hover:text-fern-accent hover:underline',
    variant === 'danger' && 'bg-[#b42318] text-white hover:bg-[#8f1c13]',
    className,
  ];
}
