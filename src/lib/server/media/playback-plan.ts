type Capability = { h264?: boolean; aac?: boolean; webm?: boolean };
type TechnicalMedia = { container: string | null; videoCodec: string | null; audioCodecSummary: string | null };
export function canDirectPlay(media: TechnicalMedia, capability: Capability = {}): boolean {
  const container = media.container?.toLowerCase() ?? '';
  const video = media.videoCodec?.toLowerCase();
  const audio = media.audioCodecSummary?.toLowerCase() ?? '';
  if (['mov', 'mp4', 'm4v'].some((v) => container.includes(v)))
    return (
      video === 'h264' && (!audio || audio.includes('aac')) && capability.h264 !== false && capability.aac !== false
    );
  if (container.includes('webm'))
    return (
      ['vp8', 'vp9', 'av1'].includes(video ?? '') && (!audio || /opus|vorbis/.test(audio)) && capability.webm !== false
    );
  return false;
}
