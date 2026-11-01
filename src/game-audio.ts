import type { AudioDecoder, ByteSource, DecoderOptions } from './contracts.js';
import { check } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { identifyGameAudioHeader } from './audio-formats.js';

export async function identifyGameAudio(
  source: ByteSource,
  name = '',
  header?: Uint8Array,
) {
  if (!source || !Number.isSafeInteger(source.size) || source.size < 4)
    return null;
  const bytes =
    header || (await readAudio(source, 0, Math.min(source.size, 128)));
  const format = identifyGameAudioHeader(bytes, name, source.size);
  return format ? { format, kind: 'audio', name, playable: true } : null;
}

export async function createGameDecoder(
  source: ByteSource,
  format: string | { format: string },
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  check(
    source &&
      Number.isSafeInteger(source.size) &&
      source.size >= 0 &&
      typeof source.read === 'function',
    'INVALID_AUDIO',
  );
  const normalized = String(
    typeof format === 'object' ? format.format : format,
  ).toUpperCase();
  if (normalized === 'HEARTBEAT') {
    check(options.heartbeat, 'HEARTBEAT_BANK');
    return (await import('./ps-heartbeat.js')).createHeartbeatDecoder(
      options.heartbeat,
      options,
    );
  }
  if (normalized === 'CSEQ') {
    check(options.cseq, 'CSEQ_BANK');
    return (await import('./audio-cseq.js')).createCseqDecoder(
      source,
      options.cseq,
      options,
    );
  }
  if (normalized === 'GBA')
    return (await import('./audio-m4a.js')).createM4aDecoder(
      source,
      options,
      options.m4a,
    );
  if (normalized === 'SEQ' || normalized === 'SEP') {
    check(options.sony, 'SONY_BANK', 'A matching VAB or VH/VB is required.');
    return (await import('./audio-sony-sequence.js')).createSonySequenceDecoder(
      source,
      options.sony.bank,
      options.sony.body,
      options,
    );
  }
  if (normalized === 'GB' || normalized === 'GBC') {
    const { createGameBoyRomDecoder } = await import('./audio-gameboy-rom.js');
    const { cartridgeInput } = await import('./cartridge-input.js');
    return cartridgeInput(
      await createGameBoyRomDecoder(source, options),
      options,
    );
  }
  if (normalized === 'RXWS')
    return (await import('./audio-rxws.js')).createRxwsDecoder(source, options);
  if (
    [
      'BRSTM',
      'RSTM',
      'RWAV',
      'BRWAV',
      'DSP',
      'CWAV',
      'FWAV',
      'CSTM',
      'FSTM',
    ].includes(normalized)
  ) {
    const nintendo = await import('./audio-nintendo.js');
    if (normalized === 'BRSTM' || normalized === 'RSTM')
      return nintendo.createBrstmDecoder(source);
    if (normalized === 'RWAV' || normalized === 'BRWAV')
      return nintendo.createRwavDecoder(source);
    if (normalized === 'DSP') return nintendo.createDspDecoder(source);
    return nintendo.createNintendoDecoder(source);
  }
  if (normalized === 'BWAV' || normalized === 'IDSP') {
    const nintendo = await import('./audio-extra-nintendo.js');
    return normalized === 'BWAV'
      ? nintendo.createBwavDecoder(source)
      : nintendo.createIdspDecoder(source);
  }
  if (normalized === 'SWAV' || normalized === 'STRM')
    return (await import('./audio-nitro-stream.js')).createNitroStreamDecoder(
      source,
      normalized,
    );
  if (normalized === 'VAG' || normalized === 'SS2' || normalized === 'ADS') {
    const playstation = await import('./audio-playstation.js');
    return normalized === 'VAG'
      ? playstation.createVagDecoder(source)
      : playstation.createSs2Decoder(source);
  }
  if (normalized === 'WAV')
    return (await import('./audio-wave.js')).createWaveDecoder(source);
  if (normalized === 'AIFF' || normalized === 'AIFC' || normalized === 'AU') {
    const pcm = await import('./audio-pcm.js');
    return normalized === 'AU'
      ? pcm.createAuDecoder(source)
      : pcm.createAiffDecoder(source);
  }
  if (normalized === 'ADX')
    return (await import('./audio-adx.js')).createAdxDecoder(source, options);
  if (normalized === 'HCA')
    return (await import('./audio-hca.js')).createHcaDecoder(source, options);
  if (normalized === 'SPC')
    return (await import('./audio-spc.js')).createSpcDecoder(source, options);
  if (normalized === 'GBS')
    return (await import('./audio-gameboy.js')).createGameBoyDecoder(
      source,
      options,
    );
  if (normalized === 'PSF' || normalized === 'PSF2') {
    const bundle =
      options.psf ||
      (await (
        await import('./psf.js')
      ).readPsf(
        source,
        options.name || 'track.' + normalized.toLowerCase(),
        options.companions || [],
      ));
    return normalized === 'PSF'
      ? (await import('./audio-psf.js')).createPsfDecoder(bundle, options)
      : (await import('./psf2-decoder.js')).createPsf2Decoder(bundle, options);
  }
  if (normalized === 'XA' || normalized === 'XA2336')
    return (await import('./audio-xa.js')).createXaDecoder(
      source,
      options,
      normalized === 'XA2336' ? 2336 : 2352,
    );
  check(false, 'CODEC', normalized);
}
