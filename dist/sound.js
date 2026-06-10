"use strict";
// Generates a very short, soft acknowledgement cue as a 16-bit PCM mono WAV.
// Mentra Live's tiny speaker can make melodic chimes sound cheap/robotic, so
// keep this closer to a quiet tactile "tap": low volume, rounded edges, almost
// no harmonics, and no bright rising melody.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ackChimeWav = ackChimeWav;
let cached = null;
function ackChimeWav() {
    if (cached)
        return cached;
    const sampleRate = 44100;
    const durationSeconds = 0.28;
    const totalSamples = Math.floor(durationSeconds * sampleRate);
    const samples = Array.from({ length: totalSamples }, () => 0);
    addSoftTone(samples, sampleRate, { freq: 392.0, startMs: 0, ms: 220, gain: 0.16 }); // G4 body
    addSoftTone(samples, sampleRate, { freq: 523.25, startMs: 72, ms: 150, gain: 0.07 }); // C5 hint
    const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0) || 1;
    for (let i = 0; i < samples.length; i += 1) {
        samples[i] = Math.tanh((samples[i] / peak) * 0.34);
    }
    cached = encodeWavMono16(samples, sampleRate);
    return cached;
}
function addSoftTone(samples, sampleRate, tone) {
    const start = Math.floor((tone.startMs / 1000) * sampleRate);
    const count = Math.floor((tone.ms / 1000) * sampleRate);
    for (let i = 0; i < count; i += 1) {
        const index = start + i;
        if (index >= samples.length)
            break;
        const t = i / sampleRate;
        const position = i / Math.max(1, count - 1);
        const attack = Math.min(1, i / (sampleRate * 0.035));
        const release = Math.max(0, 1 - position) ** 2.4;
        const env = attack * release;
        samples[index] += Math.sin(2 * Math.PI * tone.freq * t) * env * tone.gain;
    }
}
function encodeWavMono16(samples, sampleRate) {
    const dataLength = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataLength);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
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
