/**
 * Builds a minimal, silent WAV file as a data: URI at runtime.
 *
 * Safari's AirPlay route picker (`webkitShowPlaybackTargetPicker`) only
 * exists on `<audio>`/`<video>` elements, not on a raw Web Audio
 * AudioContext. So this app keeps one hidden, muted `<audio>` element
 * purely to summon that picker -- it needs *some* valid source to be a
 * legitimate media element, hence a few milliseconds of generated silence
 * rather than any real audio asset.
 */
export function createSilentWavDataUri(): string {
  const sampleRate = 8000;
  const numSamples = 8;
  const headerSize = 44;

  const bytes = new Uint8Array(headerSize + numSamples);
  const view = new DataView(bytes.buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (1 byte per sample at 8-bit)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, numSamples, true);

  // 8-bit unsigned PCM silence sits at the midpoint, 128.
  bytes.fill(128, headerSize);

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}
