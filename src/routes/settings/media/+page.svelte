<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { resolve } from '$app/paths';
  import { askConfirm } from '$lib/client/dialogs.svelte';
  import { page } from '$app/state';
  import Button from '$lib/components/Button.svelte';
  import { buttonClasses } from '$lib/components/button-classes';
  import Header from '$lib/components/Header.svelte';
  import { LibraryScan } from '$lib/client/library-scan.svelte';
  import { removeMediaRoot } from '$lib/client/media-roots';
  import { watchMediaRoots, type MediaRoot } from '$lib/client/zero/data';
  import { messageFrom } from '$lib/shared/errors';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  /** Seeded by the server, then synchronized. */
  let roots = $state<readonly MediaRoot[]>(untrack(() => data.roots));
  let message = $state('');
  const scan = new LibraryScan();
  let hydrated = $state(false);
  /** Set by the add-folder page when it navigates here; a reload does not repeat it. */
  let added = $derived(page.state.addedFolder ? `Added “${page.state.addedFolder}”.` : '');

  onMount(() => {
    hydrated = true;
    const stopWatching = watchMediaRoots((rows, resultType, queryError) => {
      if (resultType === 'complete') roots = rows;
      if (resultType === 'error') message = queryError?.message ?? 'Could not synchronize media folders.';
    });
    void scan.restore();
    return () => {
      stopWatching();
      scan.stop();
    };
  });

  async function remove(root: MediaRoot) {
    const confirmed = await askConfirm({
      title: 'Remove folder',
      message: `Fern forgets “${root.displayName}” and everything indexed in it. No media files are deleted.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await removeMediaRoot(root.id);
    } catch (error) {
      message = messageFrom(error, 'Could not remove media folder.');
    }
  }

  async function start(rootId?: string) {
    message = '';
    await scan.start(rootId);
  }

  /**
   * A root's status line: its scan while one covers it, otherwise when it was last scanned. It keeps
   * one line in every state, so a scan starting or ending never moves the list.
   */
  function rootStatus(root: MediaRoot) {
    const progress = scan.progress;
    const scanning =
      scan.running && (scan.rootId === root.id || (scan.rootId === null && progress?.currentRootId === root.id));
    if (scanning && progress?.state === 'retrying')
      return { scanning, text: `Retrying: ${progress.message ?? 'the scan will try again.'}` };
    if (scanning) return { scanning, text: progress?.currentPath ? `Scanning ${progress.currentPath}` : 'Scanning…' };
    if (scan.running && scan.rootId === null) return { scanning, text: 'Waiting to be scanned' };
    return {
      scanning,
      text: root.lastScannedAt ? `Last scanned ${new Date(root.lastScannedAt).toLocaleString()}` : 'Not scanned yet',
    };
  }
</script>

{#snippet folderIcon(className: string)}
  <svg
    class={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M3 7h6l2 2h10v10H3z" />
  </svg>
{/snippet}

<Header />
<main class="mx-auto max-w-[1168px] px-4 pt-6 pb-20 sm:px-6 sm:pt-12 md:px-10" data-hydrated={hydrated}>
  <div class="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="mb-2 text-sm font-bold text-[#c93600] uppercase">Library /</p>
      <h1 class="text-xl font-bold sm:text-2xl">Library folders</h1>
    </div>
    <div class="flex flex-wrap gap-3">
      <Button class="w-36" variant="secondary" disabled={scan.running || !roots.length} onclick={() => start()}>
        {scan.running ? 'Scanning…' : 'Scan all'}
      </Button>
      <a class={buttonClasses()} href={resolve('/settings/media/add?type=video')}>Add video folder</a>
      <a class={buttonClasses()} href={resolve('/settings/media/add?type=music')}>Add music folder</a>
    </div>
  </div>

  <section class="overflow-hidden border border-black bg-white">
    {#each roots as root (root.id)}
      {@const status = rootStatus(root)}
      <div
        class="flex flex-col gap-4 border-b border-dotted border-black p-5 last:border-0 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex min-w-0 items-center gap-4">
          <div
            class="grid size-11 shrink-0 place-items-center border border-black bg-[#e8e8e2] text-black"
            aria-hidden="true"
          >
            {@render folderIcon('size-5')}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="truncate font-semibold text-black">{root.displayName}</h2>
              <span class="border border-black bg-white px-1.5 py-0.5 text-[10px] font-semibold text-black uppercase"
                >{root.mediaType}</span
              >
              {#if root.source === 'youtube'}
                <span
                  class="border border-black bg-[#e8e8e2] px-1.5 py-0.5 text-[10px] font-semibold text-black uppercase"
                  title="Fern saves YouTube downloads here. It cannot be removed.">Downloads</span
                >
              {/if}
            </div>
            <p class="truncate text-sm text-[#6b6b67]">{root.path}</p>
            <p class="mt-1 flex h-4 min-w-0 items-center gap-2 text-xs text-[#6b6b67]" aria-live="polite">
              {#if status.scanning}<span
                  class="size-3 shrink-0 animate-spin rounded-full border-2 border-[#9b9b95] border-t-fern-accent"
                ></span>{/if}<span class="min-w-0 truncate">{status.text}</span>
            </p>
          </div>
        </div>
        <div class="flex shrink-0 gap-2 sm:justify-end">
          <Button variant="secondary" size="small" disabled={scan.running} onclick={() => start(root.id)}>Scan</Button>
          {#if root.source !== 'youtube'}
            <Button variant="danger" size="small" disabled={scan.running} onclick={() => remove(root)}>Remove</Button>
          {/if}
        </div>
      </div>
    {:else}
      <div class="grid justify-items-center px-5 py-16 text-center">
        <div class="mb-4 grid size-14 place-items-center border border-black bg-[#e8e8e2] text-[#6b6b67]">
          {@render folderIcon('size-7')}
        </div>
        <h2 class="font-semibold">No media folders</h2>
        <p class="mt-1 mb-5 text-sm text-zinc-500">Add a folder to start building your library.</p>
        <div class="flex gap-2">
          <a class={buttonClasses()} href={resolve('/settings/media/add?type=video')}>Add video</a>
          <a class={buttonClasses('secondary')} href={resolve('/settings/media/add?type=music')}>Add music</a>
        </div>
      </div>
    {/each}
  </section>

  <!-- Below the list, so a message appearing never moves it. -->
  {#if message || scan.error || added}
    <p class="mt-4 border border-black bg-white px-4 py-3 text-sm text-black" role="status">
      {message || scan.error || added}
    </p>
  {/if}
  {#if scan.progress && !scan.running}
    <p class="mt-4 text-sm text-[#6b6b67]" role="status">
      Scan {scan.progress.state}. {scan.progress.filesSeen} files · {scan.progress.videosSeen} videos · {scan.progress
        .audioSeen} songs · {scan.progress.errorsCount} errors
      {#if scan.progress.message}<br />{scan.progress.message}{/if}
    </p>
  {/if}
</main>
