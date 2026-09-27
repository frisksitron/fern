<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { clearProfileCookie } from '$lib/client/profile';

  const section = $derived(
    page.url.pathname.startsWith('/settings') ? 'settings' : page.url.pathname.startsWith('/music') ? 'music' : 'video',
  );

  function switchProfile() {
    clearProfileCookie();
    goto('/');
  }

  const sectionLink = (active: boolean) => [
    'inline-flex min-h-11 items-center no-underline',
    active ? 'text-fern-accent' : 'text-[#414141] hover:underline',
  ];
</script>

<!-- One row on phones, and it scrolls away there: the screen is short, and the player takes the bottom. -->
<header class="border-b border-black bg-fern-bg/95 backdrop-blur-sm sm:sticky sm:top-0 sm:z-20">
  <div
    class="mx-auto flex h-12 max-w-[1280px] items-center gap-4 px-4 text-sm sm:grid sm:h-16 sm:grid-cols-[32px_1fr_auto] sm:gap-6 sm:px-10 sm:text-base"
  >
    <a
      class="inline-flex min-h-11 shrink-0 items-center font-bold text-black no-underline"
      href={page.url.pathname.startsWith('/music') ? '/music' : '/browse'}
      ><span class="sm:hidden">[fern]</span><span class="hidden sm:inline">[f]</span></a
    >
    <nav class="flex items-center gap-4 font-semibold sm:gap-6" aria-label="Media type">
      <a class={sectionLink(section === 'video')} href="/browse">Video</a>
      <a class={sectionLink(section === 'music')} href="/music">Music</a>
    </nav>
    <nav class="ml-auto flex shrink-0 items-center gap-4 font-semibold">
      <a
        class={[
          'inline-flex min-h-11 items-center no-underline',
          section === 'settings' ? 'text-fern-accent' : 'text-[#414141] hover:text-fern-accent hover:underline',
        ]}
        href="/settings/media"
        ><span class="sm:hidden" aria-label="Settings">[cfg]</span><span class="hidden sm:inline">Settings</span></a
      >
      <button
        class="min-h-11 cursor-pointer border-0 bg-transparent p-0 font-semibold text-[#414141] hover:text-fern-accent hover:underline"
        onclick={switchProfile}
        ><span class="sm:hidden">Profile</span><span class="hidden sm:inline">Switch profile</span></button
      >
    </nav>
  </div>
</header>
