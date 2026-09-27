<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, compact = false, children }: { title: string; compact?: boolean; children?: Snippet } = $props();
</script>

<header
  class={[
    'flex min-h-11 items-start justify-between gap-4 border-b border-dotted border-black pb-3',
    compact ? 'mb-3' : 'mb-6',
  ]}
>
  <h2 class="min-w-0 truncate text-base leading-6 font-bold">{title} /</h2>
  {#if children}{@render children()}{/if}
</header>
