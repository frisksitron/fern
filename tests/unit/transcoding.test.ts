import { describe, expect, it } from '@effect/vitest';
import { isAcceleratorBenched, videoEncoderArgs } from '../../src/lib/server/transcoding/service';

describe('videoEncoderArgs', () => {
  it('makes software output 8-bit High profile H.264 that browsers can decode, whatever the source', () => {
    const args = videoEncoderArgs('software', 2);
    expect(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2)).toEqual(['-c:v', 'libx264']);
    expect(args.slice(args.indexOf('-pix_fmt'), args.indexOf('-pix_fmt') + 2)).toEqual(['-pix_fmt', 'yuv420p']);
    expect(args.slice(args.indexOf('-profile:v'), args.indexOf('-profile:v') + 2)).toEqual(['-profile:v', 'high']);
    expect(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 2)).toEqual(['-threads', '2']);
  });

  it('leaves pixel format conversion to the filter for hardware encoders', () => {
    for (const accelerator of ['nvenc', 'qsv'] as const) {
      const args = videoEncoderArgs(accelerator, 2);
      expect(args).toContain('format=nv12');
      expect(args).not.toContain('-pix_fmt');
    }
  });
});

describe('isAcceleratorBenched', () => {
  it('leaves a failed encoder alone for ten minutes, then forgets the failure', () => {
    expect(isAcceleratorBenched(undefined, 0)).toBe(false);
    expect(isAcceleratorBenched(1_000, 1_000 + 9 * 60_000)).toBe(true);
    expect(isAcceleratorBenched(1_000, 1_000 + 10 * 60_000)).toBe(false);
  });
});
