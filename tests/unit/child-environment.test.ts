import { describe, expect, it } from '@effect/vitest';
import { childEnvironment } from '../../src/lib/server/media/process';

describe('childEnvironment', () => {
  it('keeps what the media tools need and drops everything else', () => {
    expect(
      childEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/fern',
        TMPDIR: '/tmp',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        https_proxy: 'http://proxy:3128',
        XDG_CACHE_HOME: '/cache',
        LIBVA_DRIVER_NAME: 'iHD',
        NVIDIA_DRIVER_CAPABILITIES: 'video',
        DATABASE_URL: 'postgres://fern:secret@db/fern',
        ZERO_UPSTREAM_DB: 'postgres://fern:secret@db/fern',
        NODE_OPTIONS: '--inspect',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/fern',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      https_proxy: 'http://proxy:3128',
      XDG_CACHE_HOME: '/cache',
      LIBVA_DRIVER_NAME: 'iHD',
      NVIDIA_DRIVER_CAPABILITIES: 'video',
    });
  });

  it('matches names the way Windows spells them and skips unset values', () => {
    expect(childEnvironment({ Path: 'C:\bin', SystemRoot: 'C:\Windows', TEMP: undefined })).toEqual({
      Path: 'C:\bin',
      SystemRoot: 'C:\Windows',
    });
  });
});
