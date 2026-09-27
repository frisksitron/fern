<script lang="ts">
  import type { MediaEntry, MediaRoot } from '$lib/client/zero/data';
  import SectionHeading from '$lib/components/SectionHeading.svelte';

  let {
    basePath,
    rootLabel,
    headingLabel,
    emptyMessage,
    addFolderLabel,
    addFolderHref = '/settings/media',
    rootId = null,
    folderId = null,
    roots,
    folder,
    trail,
    directories,
    showRootHeading = false,
    draggableFolders = false,
    onFolderDragStart,
    onFolderDragEnd,
  }: {
    basePath: '/browse' | '/music';
    rootLabel: string;
    headingLabel?: string;
    emptyMessage: string;
    addFolderLabel: string;
    addFolderHref?: string;
    rootId?: string | null;
    folderId?: string | null;
    roots: readonly MediaRoot[];
    folder: MediaEntry | null;
    trail: readonly MediaEntry[];
    directories: readonly MediaEntry[];
    showRootHeading?: boolean;
    draggableFolders?: boolean;
    onFolderDragStart?: (event: DragEvent, rootId: string, folderId: string | null, label: string) => void;
    onFolderDragEnd?: () => void;
  } = $props();

  let root = $derived(roots.find((candidate) => candidate.id === rootId) ?? null);
</script>

{#if rootId && root}
  <header
    class="mb-6 flex min-h-11 flex-nowrap items-start justify-between gap-4 border-b border-dotted border-black pb-3"
  >
    <nav
      class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-base leading-6 font-bold text-[#6b6b67]"
      aria-label="Breadcrumb"
    >
      <a class="inline-flex shrink-0 items-center text-[#065ec9] underline-offset-2 hover:underline" href={basePath}
        >{headingLabel ?? rootLabel}</a
      ><span class="shrink-0 font-normal text-black">/</span>
      {#if folderId}
        <a
          class="max-w-full min-w-0 truncate text-[#065ec9] underline-offset-2 hover:underline"
          href={`${basePath}/${rootId}`}
          title={root.displayName}>{root.displayName}</a
        >
        {#each trail as crumb, index}
          <span class="shrink-0 font-normal text-black">/</span>
          {#if index === trail.length - 1}
            <span class="min-w-0 truncate text-black" title={crumb.name}>{crumb.name}</span>
          {:else}
            <a
              class="max-w-full min-w-0 truncate text-[#065ec9] underline-offset-2 hover:underline"
              href={`${basePath}/${rootId}/${crumb.id}`}
              title={crumb.name}>{crumb.name}</a
            >
          {/if}
        {/each}
      {:else}
        <span class="min-w-0 truncate text-black" title={root.displayName}>{root.displayName}</span>
      {/if}
    </nav>
  </header>

  <div class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
    <a
      class="relative col-span-2 flex h-11 items-center gap-2 overflow-hidden border border-black bg-white px-3 text-[#065ec9] underline-offset-2 transition-colors hover:bg-[#e8e8e2] hover:underline sm:col-span-1 sm:h-29.5 sm:items-end sm:p-4"
      href={folderId
        ? folder?.parentId
          ? `${basePath}/${rootId}/${folder.parentId}`
          : `${basePath}/${rootId}`
        : basePath}><span>←</span><span>{folderId ? 'Parent folder' : `All ${rootLabel.toLowerCase()}`}</span></a
    >
    {#each directories as entry (entry.id)}
      <a
        class="group relative flex h-24 items-end gap-2 overflow-hidden border border-black bg-white p-3 font-medium no-underline transition-colors hover:bg-[#fff1e8] sm:h-29.5 sm:p-4"
        href={`${basePath}/${rootId}/${entry.id}`}
        draggable={draggableFolders}
        ondragstart={(event) => onFolderDragStart?.(event, rootId, entry.id, entry.name)}
        ondragend={() => onFolderDragEnd?.()}
      >
        {#if basePath === '/music' && entry.artworkMediaEntryId}
          <img
            class="absolute inset-0 size-full object-cover"
            src={`/api/media/${entry.id}/artwork`}
            alt=""
            onerror={(event) => event.currentTarget.remove()}
          />
          <span class="absolute inset-0 bg-linear-to-t from-black/90 via-black/20 to-transparent"></span>
        {/if}
        <span class="relative text-fern-accent">[dir]</span><span
          class={['relative line-clamp-2', basePath === '/music' && entry.artworkMediaEntryId && 'text-white']}
          title={entry.name}>{entry.name}</span
        >
      </a>
    {/each}
  </div>
{:else}
  {#if showRootHeading}<SectionHeading title={headingLabel ?? rootLabel} />{/if}
  {#if roots.length === 0}
    <div class="border border-black bg-white px-8 py-20 text-center text-[#6b6b67]">
      <p class="mb-6">{emptyMessage}</p>
      <a
        class="border border-black bg-fern-accent px-5 py-3 font-medium text-black no-underline hover:bg-fern-accent-hover"
        href={addFolderHref}>{addFolderLabel}</a
      >
    </div>
  {:else}
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
      {#each roots as item}
        <a
          class="group relative flex h-24 items-end gap-2 overflow-hidden border border-black bg-white p-3 font-medium no-underline transition-colors hover:bg-[#fff1e8] sm:h-29.5 sm:p-4"
          href={`${basePath}/${item.id}`}
          draggable={draggableFolders}
          ondragstart={(event) => onFolderDragStart?.(event, item.id, null, item.displayName)}
          ondragend={() => onFolderDragEnd?.()}
        >
          <span class="relative text-fern-accent">[dir]</span><span class="relative">{item.displayName}</span>
        </a>
      {/each}
    </div>
  {/if}
{/if}
