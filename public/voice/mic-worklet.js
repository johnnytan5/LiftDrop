// Runs in an AudioContext created at 16 kHz, so the browser has already
// resampled the mic. Batches Float32 samples into 80 ms PCM16 frames.
const FRAME = 1280; // 80 ms at 16 kHz

class MicPcm16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === FRAME) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-pcm16', MicPcm16);
