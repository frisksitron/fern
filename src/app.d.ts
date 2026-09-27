import type { ProfileId } from '$lib/shared/contracts/ids';

declare global {
  namespace App {
    interface Locals {
      /** The selected profile. Set, and verified to exist, on every page that requires one. */
      profileId: ProfileId | null;
    }

    interface PageState {
      /** The folder the add-folder page just added, for the settings page to confirm. */
      addedFolder?: string;
    }
  }
}
export {};
