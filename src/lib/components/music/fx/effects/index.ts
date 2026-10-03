import type { Effect } from '../shader';
import { groove } from './groove';
import { mana } from './mana';
import { taptap } from './taptap';
import { zoltraak } from './zoltraak';

/** The FX page's effects, in the order clicking the background goes through them. */
export const EFFECTS: readonly Effect[] = [mana, zoltraak, taptap, groove];
