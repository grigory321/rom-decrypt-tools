import type { HcaMetadata } from './audio-types.js';
import { check } from './binary.js';

interface TransformTables {
  sin: Float64Array[];
  cos: Float64Array[];
  shuffle: Uint8Array;
}
interface HcaChannel {
  type: number;
  coded: number;
  scales: Uint8Array;
  resolution: Uint8Array;
  intensity: Uint8Array;
  gain: Float64Array;
  spectra: Float64Array;
  temp: Float64Array;
  dct: Float64Array;
  previous: Float64Array;
  noise: number[];
  valid: number[];
}

class HcaBits {
  readonly bytes: Uint8Array;
  position = 0;
  readonly limit: number;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.position = 0;
    this.limit = (bytes.length - 2) * 8;
  }
  peek(count: number) {
    check(this.position + count <= this.bytes.length * 8, 'INVALID_AUDIO');
    const index = this.position >> 3,
      shift = this.position & 7;
    const word =
      this.bytes[index] * 65536 +
      (this.bytes[index + 1] || 0) * 256 +
      (this.bytes[index + 2] || 0);
    return (word >>> (24 - shift - count)) & ((1 << count) - 1);
  }
  read(count: number) {
    const value = this.peek(count);
    this.skip(count);
    return value;
  }
  skip(count: number) {
    this.position += count;
    check(this.position >= 0 && this.position <= this.limit, 'INVALID_AUDIO');
  }
}

function channelTypes(metadata: HcaMetadata) {
  const count = metadata.channels / metadata.tracks,
    config = metadata.channelConfig;
  const layouts: Partial<Record<number, number[]>> = {
    2: [1, 2],
    3: [1, 2, 0],
    4: config ? [1, 2, 0, 0] : [1, 2, 1, 2],
    5: config > 2 ? [1, 2, 0, 0, 0] : [1, 2, 0, 1, 2],
    6: [1, 2, 0, 0, 1, 2],
    7: [1, 2, 0, 0, 1, 2, 0],
    8: [1, 2, 0, 0, 1, 2, 1, 2],
  };
  const layout = metadata.stereoBands ? layouts[count] : null;
  return Array.from(
    { length: metadata.channels },
    (_, index) => layout?.[index % count] || 0,
  );
}

let transformTables: TransformTables | undefined;
function dctTables() {
  if (transformTables) return transformTables;
  const sin: Float64Array[] = [],
    cos: Float64Array[] = [];
  for (let bits = 0; bits <= 7; bits++) {
    const size = 1 << bits;
    sin.push(
      Float64Array.from({ length: size }, (_, i) =>
        Math.sin((Math.PI * (4 * i + 1)) / (4 * size)),
      ),
    );
    cos.push(
      Float64Array.from({ length: size }, (_, i) =>
        Math.cos((Math.PI * (4 * i + 1)) / (4 * size)),
      ),
    );
  }
  const shuffle = Uint8Array.from({ length: 128 }, (_, i) => {
    let value = i ^ (i >> 1),
      reversed = 0;
    for (let bit = 0; bit < 7; bit++) {
      reversed = reversed * 2 + (value & 1);
      value >>= 1;
    }
    return reversed;
  });
  transformTables = { sin, cos, shuffle };
  return transformTables;
}

function inverseTransform(
  channel: HcaChannel,
  tables: typeof import('./hca-tables.js'),
) {
  const { sin, cos, shuffle } = dctTables(),
    input = channel.spectra,
    temp = channel.temp,
    dct = channel.dct;
  for (let i = 0; i < 64; i++) {
    const a = input[i * 2],
      b = input[127 - i * 2];
    temp[i * 2] = a * cos[7][i] + b * sin[7][i];
    temp[i * 2 + 1] = a * sin[7][i] - b * cos[7][i];
  }
  for (let stage = 0; stage < 6; stage++) {
    const blockSize = 1 << (6 - stage),
      half = blockSize >> 1;
    for (let block = 0; block < 1 << stage; block++) {
      for (let i = 0; i < half; i++) {
        const front = (block * blockSize + i) * 2,
          back = front + blockSize;
        const a = temp[front] - temp[back],
          b = temp[front + 1] - temp[back + 1];
        temp[front] += temp[back];
        temp[front + 1] += temp[back + 1];
        temp[back] = a * cos[5 - stage][i] + b * sin[5 - stage][i];
        temp[back + 1] = a * sin[5 - stage][i] - b * cos[5 - stage][i];
      }
    }
  }
  for (let i = 0; i < 128; i++) dct[i] = temp[shuffle[i]] * 0.125;
  const output = new Float32Array(128),
    previous = channel.previous,
    window = tables.imdctWindow;
  for (let i = 0; i < 64; i++) {
    output[i] = window[i] * dct[i + 64] + previous[i];
    output[i + 64] = window[i + 64] * dct[127 - i] - previous[i + 64];
    previous[i] = window[127 - i] * dct[63 - i];
    previous[i + 64] = window[63 - i] * dct[i];
  }
  return output;
}

function unpackScales(
  channel: HcaChannel,
  reader: HcaBits,
  metadata: HcaMetadata,
) {
  const hfrCount =
    channel.type !== 2 && metadata.version > 0x200 ? metadata.hfrGroups : 0;
  const count = channel.coded + hfrCount,
    deltaBits = reader.read(3),
    scales = channel.scales;
  scales.fill(0);
  if (deltaBits >= 6)
    for (let i = 0; i < count; i++) scales[i] = reader.read(6);
  else if (deltaBits) {
    const maximum = (1 << deltaBits) - 1;
    scales[0] = reader.read(6);
    for (let i = 1; i < count; i++) {
      const delta = reader.read(deltaBits);
      const value =
        delta === maximum
          ? reader.read(6)
          : scales[i - 1] + delta - (maximum >> 1);
      check(value >= 0 && value < 64, 'INVALID_AUDIO');
      scales[i] = value;
    }
  }
  for (let i = hfrCount - 1; i >= 0; i--)
    scales[128 - hfrCount + i] = scales[channel.coded + i];
  if (channel.type !== 2) {
    if (metadata.version <= 0x200)
      for (let i = 0; i < metadata.hfrGroups; i++)
        scales[128 - metadata.hfrGroups + i] = reader.read(6);
    return;
  }
  let value = reader.peek(4);
  if (metadata.version <= 0x200) {
    channel.intensity[0] = value;
    if (value < 15) {
      reader.skip(4);
      for (let i = 1; i < 8; i++) channel.intensity[i] = reader.read(4);
    }
  } else {
    reader.skip(4);
    if (value === 15) channel.intensity.fill(7);
    else {
      channel.intensity[0] = value;
      const deltaBits = reader.read(2),
        maximum = (2 << deltaBits) - 1;
      for (let i = 1; i < 8; i++) {
        if (deltaBits === 3) value = reader.read(4);
        else {
          const delta = reader.read(deltaBits + 1);
          value =
            delta === maximum ? reader.read(4) : value + delta - (maximum >> 1);
        }
        check(value >= 0 && value <= 15, 'INVALID_AUDIO');
        channel.intensity[i] = value;
      }
    }
  }
}

export async function createFrameDecoder(metadata: HcaMetadata) {
  const tables = await import('./hca-tables.js');
  const ath = Uint8Array.from({ length: 128 }, (_, i) =>
    metadata.athType
      ? (tables.athBaseCurve[
          Math.floor(((i + 1) * metadata.sampleRate) / 8192)
        ] ?? 255)
      : 0,
  );
  const channels: HcaChannel[] = channelTypes(metadata).map((type) => ({
    type,
    coded: metadata.baseBands + (type === 2 ? 0 : metadata.stereoBands),
    scales: new Uint8Array(128),
    resolution: new Uint8Array(128),
    intensity: new Uint8Array(8),
    gain: new Float64Array(128),
    spectra: new Float64Array(128),
    temp: new Float64Array(128),
    dct: new Float64Array(128),
    previous: new Float64Array(128),
    noise: [],
    valid: [],
  }));
  let random = 1,
    keyEvidence = false;
  return {
    get keyEvidence() {
      return keyEvidence;
    },
    decode(bytes: Uint8Array, validateKey = false) {
      keyEvidence = false;
      const reader = new HcaBits(bytes);
      check(reader.read(16) === 65535, 'INVALID_AUDIO');
      const noise = reader.read(9),
        boundary = reader.read(7);
      for (const channel of channels) {
        unpackScales(channel, reader, metadata);
        channel.noise.length = 0;
        channel.valid.length = 0;
        for (let i = 0; i < channel.coded; i++) {
          const scale = channel.scales[i];
          let resolution = 0;
          if (scale) {
            const curve =
              ath[i] + noise - (i < boundary ? 1 : 0) + 1 - ((5 * scale) >> 1);
            resolution = curve < 0 ? 15 : tables.resolutionCurve[curve] || 0;
            resolution = Math.max(
              metadata.minResolution,
              Math.min(metadata.maxResolution, resolution),
            );
            (resolution ? channel.valid : channel.noise).push(i);
          }
          channel.resolution[i] = resolution;
          channel.gain[i] =
            tables.dequantizerScaling[scale] * tables.quantizerStep[resolution];
        }
      }
      const output = channels.map(() => new Float32Array(1024));
      for (let subframe = 0; subframe < 8; subframe++) {
        for (const channel of channels) {
          channel.spectra.fill(0);
          for (let band = 0; band < channel.coded; band++) {
            const resolution = channel.resolution[band],
              maximum = tables.spectrumMaxBits[resolution];
            const code = reader.peek(maximum);
            let value: number,
              bits = maximum;
            if (resolution > 7) {
              value = (code >> 1) * (code & 1 ? -1 : 1);
              if (!value) bits--;
            } else {
              bits = tables.spectrumBits[resolution * 16 + code];
              value = tables.spectrumValues[resolution * 16 + code];
            }
            reader.skip(bits);
            channel.spectra[band] = value * channel.gain[band];
          }
        }
        for (const channel of channels) {
          if (
            !metadata.minResolution &&
            channel.valid.length &&
            channel.noise.length
          ) {
            for (const target of channel.noise) {
              random = (Math.imul(random, 0x343fd) + 0x269ec3) >>> 0;
              const index =
                (((random >>> 16) & 32767) * channel.valid.length) >> 15;
              const source = channel.valid[channel.valid.length - 1 - index];
              const scale = Math.max(
                0,
                channel.scales[target] - channel.scales[source] + 62,
              );
              channel.spectra[target] =
                tables.scaleConversion[scale] * channel.spectra[source];
            }
          }
          if (metadata.hfrBands && channel.type !== 2) {
            let high = metadata.baseBands + metadata.stereoBands,
              low = high - 1;
            const limit =
              metadata.version <= 0x200
                ? metadata.hfrGroups
                : metadata.hfrGroups >> 1;
            for (let group = 0; group < metadata.hfrGroups; group++) {
              for (
                let i = 0;
                i < metadata.hfrBands && high < metadata.totalBands && low >= 0;
                i++
              ) {
                const scale = Math.max(
                  0,
                  channel.scales[128 - metadata.hfrGroups + group] -
                    channel.scales[low] +
                    63,
                );
                channel.spectra[high++] =
                  tables.scaleConversion[scale] * channel.spectra[low];
                low += group < limit ? -1 : 1;
              }
            }
            channel.spectra[high - 1] = 0;
          }
        }
        for (let i = 0; i < channels.length - 1; i++) {
          const left = channels[i],
            right = channels[i + 1];
          if (left.type !== 1) continue;
          const ratio = tables.intensityRatios[right.intensity[subframe]];
          for (
            let band = metadata.baseBands;
            band < metadata.totalBands;
            band++
          ) {
            right.spectra[band] = left.spectra[band] * (2 - ratio);
            left.spectra[band] *= ratio;
          }
        }
        channels.forEach((channel, i) =>
          output[i].set(inverseTransform(channel, tables), subframe * 128),
        );
      }
      if (validateKey) {
        for (let i = Math.ceil(reader.position / 8); i < bytes.length - 2; i++)
          check(bytes[i] === 0, 'INVALID_AUDIO', 'HCA nonzero frame padding');
        let lastNonzero = bytes.length - 3;
        while (lastNonzero > 1 && bytes[lastNonzero] === 0) lastNonzero--;
        keyEvidence = Math.ceil(reader.position / 8) - lastNonzero <= 2;
        check(
          output.every((channel) =>
            channel.every(
              (value) => Number.isFinite(value) && Math.abs(value) <= 1,
            ),
          ),
          'INVALID_AUDIO',
        );
      }
      check(
        output.every((channel) => channel.every(Number.isFinite)),
        'INVALID_AUDIO',
      );
      return output;
    },
  };
}
