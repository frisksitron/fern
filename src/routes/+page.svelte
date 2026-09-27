<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { askConfirm, askText } from '$lib/client/dialogs.svelte';
  import { createProfile, deleteProfile, updateProfile, watchProfiles, type Profile } from '$lib/client/zero/data';
  import { AVATARS } from '$lib/shared/constants';
  import Button from '$lib/components/Button.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  /** Seeded by the server, then synchronized. */
  let profiles = $state<readonly Profile[]>(untrack(() => data.profiles));
  let name = $state('');
  let avatarKey = $state(AVATARS[0]);
  let editing = $state(false);
  let error = $state('');

  onMount(() => {
    return watchProfiles((rows, resultType, queryError) => {
      if (resultType === 'complete') profiles = rows;
      if (resultType === 'error') error = queryError?.message ?? 'Could not synchronize profiles.';
    });
  });

  // Android's back button closes the form.
  beforeNavigate(({ type, cancel }) => {
    if (!editing || type !== 'popstate') return;
    cancel();
    editing = false;
  });

  async function create() {
    error = '';
    try {
      await createProfile(name, avatarKey);
      name = '';
      editing = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not create profile.';
    }
  }

  function select(id: string) {
    document.cookie = `profileId=${id}; Path=/; Max-Age=31536000; SameSite=Lax`;
    goto('/browse');
  }

  async function rename(profile: Profile) {
    const next = await askText({ title: 'Rename profile', label: 'Name', value: profile.name, maxLength: 50 });
    if (!next || next === profile.name) return;
    try {
      await updateProfile(profile.id, { name: next });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not rename profile.';
    }
  }

  async function cycleAvatar(profile: Profile) {
    const index = (AVATARS.indexOf(profile.avatarKey) + 1) % AVATARS.length;
    try {
      await updateProfile(profile.id, { avatarKey: AVATARS[index] });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not update avatar.';
    }
  }

  async function remove(id: string) {
    const confirmed = await askConfirm({
      title: 'Delete profile',
      message: 'This deletes the profile and all its playback progress and playlists.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteProfile(id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not delete profile.';
    }
  }
</script>

<main class="grid min-h-svh place-content-center bg-fern-bg px-6 py-12 text-center">
  <p class="mb-3 text-sm font-bold text-[#c93600]">Fern</p>
  <h1 class="mb-12 text-2xl font-bold sm:text-3xl">Who's watching?</h1>
  {#if error && !editing}<p
      class="mb-6 border border-[#b42318] bg-[#fff0ed] px-4 py-3 text-sm text-[#b42318]"
      role="alert"
    >
      {error}
    </p>{/if}
  <div class="flex max-w-5xl flex-wrap items-start justify-center gap-5 sm:gap-10">
    {#each profiles as profile}
      <div class="group relative w-37.5 border border-black bg-white p-3">
        <button
          class="grid w-full cursor-pointer gap-3 border-0 bg-transparent p-0 text-base font-normal text-black hover:text-[#065ec9] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-black"
          onclick={() => select(profile.id)}
          aria-label={`Use profile ${profile.name}`}
        >
          <img
            class="aspect-square w-full border border-black"
            src={`/avatars/${profile.avatarKey}.svg`}
            width="124"
            height="124"
            alt=""
          />
          <span>{profile.name}</span>
        </button>
        <div
          class="mt-1 grid grid-cols-3 justify-center opacity-100 transition-opacity sm:absolute sm:inset-x-0 sm:top-full sm:mt-0 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          <button
            class="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-[11px] text-[#065ec9] hover:underline"
            onclick={() => rename(profile)}>rename</button
          >
          <button
            class="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-[11px] text-[#065ec9] hover:underline"
            onclick={() => cycleAvatar(profile)}>avatar</button
          >
          <button
            class="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-[11px] text-[#b42318] hover:underline"
            onclick={() => remove(profile.id)}>delete</button
          >
        </div>
      </div>
    {/each}
    <button
      class="group grid w-37.5 cursor-pointer gap-3 border border-black bg-white p-3 text-[#065ec9] hover:bg-[#fff1e8]"
      onclick={() => (editing = true)}
    >
      <span
        class="grid aspect-square w-full place-content-center border border-dotted border-black bg-fern-panel text-5xl font-light text-fern-accent"
        >+</span
      >
      <span>Create profile</span>
    </button>
  </div>

  {#if editing}
    <div
      class="fixed inset-0 z-20 grid place-items-center bg-black/60 p-4 max-sm:place-items-start max-sm:justify-items-stretch max-sm:pt-[8dvh]"
    >
      <form
        class="max-h-full w-full max-w-145 overflow-y-auto border border-black bg-white p-6 text-left shadow-[8px_8px_0_#000] sm:p-8"
        onsubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h2 class="mb-5 text-xl font-bold">Create profile /</h2>
        <label class="grid gap-2 text-sm text-black"
          >Name<input
            class="border border-black bg-white px-3 py-3 text-black focus:outline-2 focus:outline-offset-2 focus:outline-black"
            bind:value={name}
            maxlength="50"
            required
          /></label
        >
        <fieldset class="mt-5 border-0 p-0">
          <legend class="mb-3 text-sm text-black">Avatar</legend>
          <div class="flex flex-wrap gap-3">
            {#each AVATARS as key}
              <label class="cursor-pointer"
                ><input class="peer absolute opacity-0" type="radio" bind:group={avatarKey} value={key} /><img
                  class="size-14.5 border border-black peer-checked:outline-3 peer-checked:outline-offset-2 peer-checked:outline-fern-accent"
                  src={`/avatars/${key}.svg`}
                  width="58"
                  height="58"
                  alt={key}
                /></label
              >
            {/each}
          </div>
        </fieldset>
        {#if error}<p class="mt-4 text-sm text-[#b42318]" role="alert">{error}</p>{/if}
        <div class="mt-6 flex justify-end gap-3">
          <Button type="button" variant="secondary" onclick={() => (editing = false)}>Cancel</Button>
          <Button type="submit">Create</Button>
        </div>
      </form>
    </div>
  {/if}
</main>
