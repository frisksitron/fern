<script lang="ts">
  import { beforeNavigate } from '$app/navigation';
  import Button from '$lib/components/Button.svelte';
  import { answer, dialogs } from '$lib/client/dialogs.svelte';

  let text = $state('');

  $effect(() => {
    if (dialogs.current?.kind === 'text') text = dialogs.current.value;
  });

  // Android's back button closes the dialog rather than leaving the page under it.
  beforeNavigate(({ type, cancel }) => {
    if (!dialogs.current || type !== 'popstate') return;
    cancel();
    answer(null);
  });

  function dismiss(event: MouseEvent) {
    if (event.target === event.currentTarget) answer(null);
  }
</script>

<svelte:window onkeydown={(event) => dialogs.current && event.key === 'Escape' && answer(null)} />

{#if dialogs.current}
  {@const dialog = dialogs.current}
  <!-- High on phones, so the on-screen keyboard does not cover the buttons. -->
  <div
    class="fixed inset-0 z-60 grid place-items-center bg-black/60 p-4 max-sm:place-items-start max-sm:justify-items-stretch max-sm:pt-[12dvh]"
    role="presentation"
    onclick={dismiss}
  >
    <div
      class="w-full max-w-md border border-black bg-white p-6 text-left text-black shadow-[8px_8px_0_#000] sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <form
        onsubmit={(event) => {
          event.preventDefault();
          answer(dialog.kind === 'text' ? text : true);
        }}
      >
        <h2 id="dialog-title" class="mb-5 text-xl font-bold">{dialog.title} /</h2>
        {#if dialog.kind === 'text'}
          <label class="grid gap-2 text-sm"
            >{dialog.label}<!-- svelte-ignore a11y_autofocus --><input
              class="border border-black bg-white px-3 py-3 text-black focus:outline-2 focus:outline-offset-2 focus:outline-black"
              bind:value={text}
              maxlength={dialog.maxLength}
              required
              autofocus
            /></label
          >
        {:else}
          <p class="text-sm leading-6 text-[#414141]">{dialog.message}</p>
        {/if}
        <div class="mt-6 flex justify-end gap-3">
          <Button type="button" variant="secondary" onclick={() => answer(null)}>Cancel</Button>
          <Button type="submit" variant={dialog.kind === 'confirm' && dialog.danger ? 'danger' : 'primary'}
            >{dialog.confirmLabel}</Button
          >
        </div>
      </form>
    </div>
  </div>
{/if}
