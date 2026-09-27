<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { buttonClasses, type ButtonSize, type ButtonVariant } from './button-classes';

  let {
    variant = 'primary',
    size = 'medium',
    class: className,
    children,
    ...attributes
  }: HTMLButtonAttributes & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    children: Snippet;
  } = $props();

  const classes = $derived(buttonClasses(variant, size, className));
</script>

<button {...attributes} class={classes}>{@render children()}</button>
