"use strict";
// Generates a short, soft acknowledgement chime as a 16-bit PCM mono WAV. The
// app serves this so the glasses can play it the instant the wake word is heard
// — no external asset hosting or binary committed to the repo. Keep it modern
// and gentle: slow attack, rounded release, warm intervals, no robotic beeps.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ackChimeWav = ackChimeWav;
let cached = null;
function ackChimeWav() {
    if (cached)
        return cached;
    const sampleRate = 44100;
    const tones = [
        { freq: 523.25, startMs: 0, ms: 420, gain: 0.34 }, // C5, soft body
        { freq: 659.25, startMs: 100, ms: 380, gain: 0.22 }, // E5, warmth
        { freq: 783.99, startMs: 200, ms: 340, gain: 0.19 }, // G5, gentle lift
    ];
    const totalSamples = Math.floor(0.64 * sampleRate);
    const samples = Array.from({ length: totalSamples }, () => 0);
    for (const tone of tones) {
        const start = Math.floor((tone.startMs / 1000) * sampleRate);
        const count = Math.floor((tone.ms / 1000) * sampleRate);
        for (let i = 0; i < count; i += 1) {
            const index = start + i;
            if (index >= samples.length)
                break;
            const t = i / sampleRate;
            const attack = Math.min(1, i / (sampleRate * 0.055));
            const release = Math.max(0, 1 - (i / Math.max(1, count)) ** 1.75);
            const env = attack * release;
            const fundamental = Math.sin(2 * Math.PI * tone.freq * t);
            const airyPartial = 0.18 * Math.sin(2 * Math.PI * tone.freq * 2.01 * t) * (release ** 2);
            samples[index] += tone.gain * env * (fundamental + airyPartial);
        }
    }
    const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0) || 1;
    for (let i = 0; i < samples.length; i += 1) {
        if (i > sampleRate * 0.5) {
            const tail = Math.max(0, 1 - (i - sampleRate * 0.5) / (samples.length - sampleRate * 0.5)) ** 2;
            samples[i] *= tail;
        }
        const scaled = (samples[i] / peak) * 0.72 * 1.25;
        samples[i] = Math.tanh(scaled) / Math.tanh(1.25);
    }
    cached = encodeWavMono16(samples, sampleRate);
    return cached;
}
function encodeWavMono16(samples, sampleRate) {
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
