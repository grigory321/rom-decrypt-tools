import { check } from '../binary.js';

export class AudioVisualizer {
  analyser: AnalyserNode;
  input: AnalyserNode;
  meters: AnalyserNode[];
  frequency: Uint8Array<ArrayBuffer>;
  samples: Float32Array<ArrayBuffer>;
  levelSamples: Float32Array<ArrayBuffer>;
  mode: 'spectrum' | 'waveform';
  constructor(context: BaseAudioContext, destination: AudioNode) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.78;
    this.analyser.connect(destination);
    this.input = this.analyser;
    const splitter = context.createChannelSplitter(2);
    this.analyser.connect(splitter);
    this.meters = [0, 1].map((channel) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      splitter.connect(analyser, channel);
      return analyser;
    });
    this.frequency = new Uint8Array(this.analyser.frequencyBinCount);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.levelSamples = new Float32Array(256);
    this.mode = 'spectrum';
  }

  draw(canvas: HTMLCanvasElement, active: boolean) {
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 92;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const targetWidth = Math.round(width * ratio);
    const targetHeight = Math.round(height * ratio);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext('2d');
    check(ctx, 'CANVAS_CONTEXT');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (this.mode === 'waveform') {
      if (active) this.analyser.getFloatTimeDomainData(this.samples);
      ctx.strokeStyle = '#9be5f5';
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      for (let x = 0; x < width; x += 2) {
        const sample = active
          ? this.samples[Math.floor((x / width) * this.samples.length)]
          : 0;
        const y = height / 2 - sample * height * 0.44;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.stroke();
      return;
    }

    if (active) this.analyser.getByteFrequencyData(this.frequency);
    const count = Math.max(20, Math.min(64, Math.floor(width / 10)));
    const gap = 4;
    const barWidth = (width - (count - 1) * gap) / count;
    const colors = ['#70c6f7', '#9adee3', '#8ad8b5', '#ffdd83', '#f5ad7f'];

    for (let i = 0; i < count; i++) {
      const low = Math.floor((i / count) ** 1.8 * this.frequency.length);
      const high = Math.max(
        low + 1,
        Math.floor(((i + 1) / count) ** 1.8 * this.frequency.length),
      );
      let value = 0;

      if (active) {
        for (let bin = low; bin < high; bin++)
          value = Math.max(value, this.frequency[bin]);
      }

      const barHeight = Math.max(3, (value / 255) * (height - 5));
      ctx.fillStyle = active
        ? colors[Math.floor((i / count) * colors.length)]
        : '#3b5879';
      ctx.beginPath();
      ctx.roundRect(
        i * (barWidth + gap),
        height - barHeight,
        barWidth,
        barHeight,
        3,
      );
      ctx.fill();
    }
  }

  levels(active: boolean) {
    return this.meters.map((analyser) => {
      if (!active) return 0;
      analyser.getFloatTimeDomainData(this.levelSamples);
      let sum = 0;
      for (const value of this.levelSamples) sum += value * value;
      const rms = Math.sqrt(sum / this.levelSamples.length);
      return Math.max(
        0,
        Math.min(1, (20 * Math.log10(Math.max(rms, 0.001)) + 60) / 60),
      );
    });
  }
}
