<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import Button from '$lib/components/Button.svelte';
  import Header from '$lib/components/Header.svelte';
  import { addMediaRoot } from '$lib/client/media-roots';
  import { messageFrom } from '$lib/shared/errors';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let message = $state('');
  let hydrated = $state(false);

  onMount(() => {
    hydrated = true;
  });

  function folderQuery(path?: string | null) {
    const params = new URLSearchParams({ type: data.type });
    if (path) params.set('path', path);
    return params.toString();
  }

  async function add(path: string) {
    message = '';
    try {
      const root = await addMediaRoot(path, data.type);
      await goto(resolve('/settings/media'), { state: { addedFolder: root.displayName } });
    } catch (error) {
      message = messageFrom(error, 'Could not add media folder.');
    }
  }
</script>

<Header />
<main class="mx-auto max-w-[1168px] px-4 pt-6 pb-20 sm:px-6 sm:pt-12 md:px-10" data-hydrated={hydrated}>
  <div class="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <a
        class="mb-1 inline-flex min-h-11 items-center text-sm text-[#065ec9] no-underline hover:underline"
        href={resolve('/settings/media')}>← Library folders</a
      >
      <h1 class="text-xl font-bold sm:text-2xl">Choose a {data.type} folder /</h1>
    </div>
  </div>

  {#if message || data.error}
    <p class="mb-5 border border-[#b42318] bg-[#fff0ed] px-4 py-3 text-sm text-[#b42318]">
      {message || data.error}
    </p>
  {/if}

  <!-- The folder's action sits with its path, so the page keeps one layout at every level. -->
  <nav
    class="mb-4 flex min-h-14 items-center gap-2 border-b border-dotted border-black pb-3 text-sm text-[#6b6b67]"
    aria-label="Current folder"
  >
    <a
      class="inline-flex min-h-11 items-center text-[#065ec9] no-underline hover:underline"
      href={resolve(`/settings/media/add?${folderQuery()}`)}>Computer</a
    >
    {#if data.currentPath}
      <span>/</span>
      <span class="min-w-0 flex-1 truncate text-black" title={data.currentPath}>{data.currentPath}</span>
      <Button class="shrink-0" size="small" onclick={() => add(data.currentPath!)}>Select this folder</Button>
    {/if}
  </nav>

  <section class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
    {#if data.currentPath}
      <a
        class="relative flex min-h-24 items-end gap-2 overflow-hidden border border-black bg-white p-3 text-[#065ec9] no-underline hover:bg-[#e8e8e2] sm:min-h-28 sm:p-4"
        href={resolve(`/settings/media/add?${folderQuery(data.parentPath)}`)}
      >
        <span class="text-fern-accent">←</span>
        <span>Parent folder</span>
      </a>
    {/if}
    {#each data.directories as directory (directory.path)}
      <div class="group relative min-w-0">
        <a
          class="relative flex min-h-24 w-full items-end gap-2 overflow-hidden border border-black bg-white p-3 font-medium text-black no-underline hover:bg-[#fff1e8] sm:min-h-28 sm:p-4"
          href={resolve(`/settings/media/add?${folderQuery(directory.path)}`)}
        >
          <span class="relative text-fern-accent">[dir]</span>
          <span class="relative min-w-0 truncate">{directory.name}</span>
        </a>
        <Button
          class="absolute top-2 right-2 z-3 opacity-100 sm:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          size="small"
          variant="secondary"
          onclick={() => add(directory.path)}
        >
          Select
        </Button>
      </div>
    {/each}
  </section>
  {#if !data.directories.length && !data.currentPath && !data.error}
    <p class="border border-black bg-white px-5 py-12 text-center text-sm text-[#6b6b67]">
      No filesystem locations are available.
    </p>
  {/if}
</main>
