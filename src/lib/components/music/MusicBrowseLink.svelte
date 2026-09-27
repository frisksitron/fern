<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import type { ClassValue } from 'svelte/elements';
  import { parseMusicBrowsePath } from '$lib/music/paths';

  let {
    pathname,
    class: className,
    children,
  }: {
    pathname: string;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  const target = $derived(parseMusicBrowsePath(pathname));
</script>

{#if target.root && target.folder}
  <a class={className} href={resolve('/music/[root]/[folder]', { root: target.root, folder: target.folder })}
    >{@render children()}</a
  >
{:else if target.root}
  <a class={className} href={resolve('/music/[root]', { root: target.root })}>{@render children()}</a>
{:else}
  <a class={className} href={resolve('/music')}>{@render children()}</a>
{/if}
