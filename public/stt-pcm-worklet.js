const STT_SAMPLE_RATE = 16000;
const PCM_FRAME_SAMPLES = 1280;

class SttPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.revision = 0;
    this.phase = 0;
    this.sum = 0;
    this.inputSamples = 0;
    this.length = 0;
    this.frame = new DataView(new ArrayBuffer(PCM_FRAME_SAMPLES * 2));
    this.port.onmessage = ({ data }) => {
      this.revision = data;
      this.phase = 0;
      this.sum = 0;
      this.inputSamples = 0;
      this.length = 0;
    };
  }

  process(inputs) {
    // The AudioWorkletNode downmixes the captured audio to one channel.
    const samples = inputs[0]?.[0];
    if (!samples) return true;

    for (let index = 0; index < samples.length; index += 1) {
      this.sum += samples[index];
      this.inputSamples += 1;
      this.phase += STT_SAMPLE_RATE;
      if (this.phase < sampleRate) continue;

      const sample = Math.max(-1, Math.min(1, this.sum / this.inputSamples));
      const pcm = sample * (sample < 0 ? 0x8000 : 0x7fff);
      this.sum = 0;
      this.inputSamples = 0;
      while (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.frame.setInt16(this.length * 2, pcm, true);
        this.length += 1;
        if (this.length === PCM_FRAME_SAMPLES) {
          const buffer = this.frame.buffer;
          this.port.postMessage({ buffer, revision: this.revision }, [buffer]);
          this.frame = new DataView(new ArrayBuffer(PCM_FRAME_SAMPLES * 2));
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("stt-pcm", SttPcmProcessor);
