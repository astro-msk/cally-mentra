// Generates a short, pleasant two-tone acknowledgement chime as a 16-bit PCM
// mono WAV. The app serves this so the glasses can play it the instant the wake
// word is heard — no external asset hosting or binary committed to the repo.

let cached: Buffer | null = null;

export function ackChimeWav(): Buffer {
  if (cached) return cached;
  const sampleRate = 22050;
  const tones = [
    { freq: 880, ms: 110 }, // A5
    { freq: 1318.5, ms: 150 }, // E6 — rising interval reads as a friendly "ready"
  ];
  const samples: number[] = [];
  for (const tone of tones) {
    const count = Math.floor((tone.ms / 1000) * sampleRate);
    for (let i = 0; i < count; i += 1) {
      const t = i / sampleRate;
      // Short attack / longer release envelope to avoid clicks at the edges.
      const env = Math.min(1, i / (sampleRate * 0.008), (count - i) / (sampleRate * 0.025));
      samples.push(Math.sin(2 * Math.PI * tone.freq * t) * env * 0.6);
    }
  }
  cached = encodeWavMono16(samples, sampleRate);
  return cached;
}

function encodeWavMono16(samples: number[], sampleRate: number): Buffer {
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate (sampleRate * blockAlign)
  buffer.writeUInt16LE(2, 32); // block align (channels * bytesPerSample)
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clamped * 32767), offset);
    offset += 2;
  }
  return buffer;
}
