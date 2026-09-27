<script lang="ts">
  import { tick } from 'svelte';
  import { getPlaylistActions, type MenuItem } from './playlist-actions.svelte';

  const actions = getPlaylistActions();
  let menu = $state<HTMLElement>();

  $effect(() => {
    if (!actions.menu) return;
    void tick().then(() => menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  });

  function choose(item: MenuItem) {
    actions.closeMenu();
    if ('run' in item) void item.run();
  }

  /** Arrow keys, Home, and End move between items; Escape and Tab close the menu. */
  function navigate(event: KeyboardEvent) {
    const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      actions.closeMenu({ restoreFocus: true });
    } else if (event.key === 'Tab') actions.closeMenu({ restoreFocus: true });
  }
</script>

{#if actions.menu}
  <!-- Takes the tap that closes the menu, so it does not also play or select the song underneath. -->
  <div
    class="fixed inset-0 z-50"
    role="presentation"
    onclick={() => actions.closeMenu()}
    oncontextmenu={(event) => {
      event.preventDefault();
      actions.closeMenu();
    }}
  ></div>
  <div
    bind:this={menu}
    class="fixed z-50 w-56 border border-black bg-white p-1 shadow-[4px_4px_0_#000]"
    style:left="{actions.menu.x}px"
    style:top="{actions.menu.y}px"
    role="menu"
    tabindex="-1"
    onkeydown={navigate}
  >
    {#each actions.menu.items as item (item.label)}
      {@const classes = [
        'flex min-h-10 w-full cursor-pointer pointer-coarse:min-h-11 items-center border-0 bg-transparent px-3 text-left text-sm no-underline outline-none',
        item.danger
          ? 'text-[#b42318] hover:bg-[#fff0ed] focus-visible:bg-[#fff0ed]'
          : 'text-black hover:bg-[#e8e8e2] focus-visible:bg-[#e8e8e2]',
      ]}
      {#if 'href' in item}
        <a class={classes} href={item.href} role="menuitem" onclick={() => actions.closeMenu()}>{item.label}</a>
      {:else}
        <button class={classes} type="button" role="menuitem" onclick={() => choose(item)}>{item.label}</button>
      {/if}
    {/each}
  </div>
{/if}
