// Runs on the audio thread. Takes microphone audio at the device's sample rate,
// downsamples to 16 kHz mono, converts to 16-bit little-endian PCM (the format
// the Live API documents for input) and posts ~40 ms chunks to the main thread.

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 640; // 40 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // `sampleRate` is a worklet global
    this.acc = 0;
    this.count = 0;
    this.phase = 0;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.count += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        const avg = this.acc / this.count;
        const clamped = Math.max(-1, Math.min(1, avg));
        this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        this.acc = 0;
        this.count = 0;
        this.phase -= this.ratio;
        if (this.outLen === CHUNK_SAMPLES) {
          const copy = this.out.slice(0);
          this.port.postMessage(copy.buffer, [copy.buffer]);
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
