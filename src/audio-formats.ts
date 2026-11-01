import { Bin } from './binary.js';

export const gameAudioExtensions = [
  'bcseq',
  'cseq',
  'seq',
  'sep',
  'xws',
  'xwh',
  'brstm',
  'rwav',
  'brwav',
  'dsp',
  'vag',
  'ss2',
  'ads',
  'wav',
  'spc',
  'gbs',
  'psf',
  'psf2',
  'minipsf',
  'minipsf2',
  'xa',
  'str',
  'pxa',
  'xai',
  'ixa',
  'xap',
  'bcwav',
  'bcstm',
  'bfwav',
  'bfstm',
  'cwav',
  'cstm',
  'fwav',
  'fstm',
  'swav',
  'strm',
  'adx',
  'adp',
  'sfa',
  'hca',
  'bwav',
  'idsp',
  'aif',
  'aiff',
  'aifc',
  'au',
  'snd',
];
const extensions = new Set(gameAudioExtensions);

export const sourceAudioFormats = new Set([
  'HEARTBEAT',
  'XA',
  'XA2336',
  'CSEQ',
  'GBA',
  'SEQ',
  'SEP',
  'GB',
  'GBC',
  'RXWS',
  'BRSTM',
  'RSTM',
  'RWAV',
  'DSP',
  'VAG',
  'SS2',
  'WAV',
  'SPC',
  'GBS',
  'PSF',
  'PSF2',
  'CWAV',
  'FWAV',
  'CSTM',
  'FSTM',
  'SWAV',
  'STRM',
  'ADX',
  'HCA',
  'BWAV',
  'IDSP',
  'AIFF',
  'AIFC',
  'AU',
]);

export function isGameAudioFile(name: string) {
  return extensions.has((name.split('.').at(-1) ?? '').toLowerCase());
}

export function identifyGameAudioHeader(
  bytes: Uint8Array,
  name = '',
  size = bytes.length,
) {
  if (bytes.length < 4) return null;
  const header = new Bin(bytes),
    magic = header.str(0, 4);
  if (header.str(0, 3) === 'PSF' && [1, 2].includes(bytes[3]))
    return bytes[3] === 1 ? 'PSF' : 'PSF2';
  if (header.str(0, 3) === 'GBS' && bytes[3] === 1 && size >= 0x71)
    return 'GBS';
  if (magic === 'RXWS') return 'RXWS';
  if (magic === 'RSTM') return 'BRSTM';
  if (['RWAV', 'CWAV', 'FWAV', 'CSTM', 'FSTM', 'BWAV', 'IDSP'].includes(magic))
    return magic;
  if (
    bytes[0] === 128 &&
    bytes[1] === 0 &&
    bytes.length >= 20 &&
    [2, 3, 4].includes(bytes[4])
  )
    return 'ADX';
  if (
    bytes
      .slice(0, 4)
      .every((value, index) => (value & 127) === [72, 67, 65, 0][index])
  )
    return 'HCA';
  if (['VAGp', 'VAGi', 'VAG1', 'VAG2'].includes(magic)) return 'VAG';
  if (magic === 'SShd' && bytes.length >= 40 && header.str(32, 4) === 'SSbd')
    return 'SS2';
  if (
    ['RIFF', 'RF64', 'BW64'].includes(magic) &&
    bytes.length >= 12 &&
    header.str(8, 4) === 'WAVE'
  )
    return 'WAV';
  if (
    magic === 'FORM' &&
    bytes.length >= 12 &&
    ['AIFF', 'AIFC'].includes(header.str(8, 4))
  )
    return header.str(8, 4);
  if (magic === '.snd') return 'AU';
  if (
    (magic === 'RIFF' && bytes.length >= 44 && header.str(8, 4) === 'CDXA') ||
    (bytes.length >= 24 &&
      bytes[0] === 0 &&
      bytes.subarray(1, 11).every((value) => value === 255) &&
      bytes[11] === 0 &&
      bytes[15] === 2 &&
      bytes
        .subarray(16, 20)
        .every((value, index) => value === bytes[index + 20]) &&
      /\.(xa|str|pxa|xai|ixa|xap)$/i.test(name))
  )
    return 'XA';
  if (
    bytes.length >= 8 &&
    size >= 2336 &&
    size % 2336 === 0 &&
    /\.(xa|str|pxa|xai|ixa|xap)$/i.test(name) &&
    bytes[1] !== 255 &&
    (bytes[2] & 0x0e) !== 0 &&
    bytes.subarray(0, 4).every((value, index) => value === bytes[index + 4])
  )
    return 'XA2336';
  if (
    bytes.length >= 35 &&
    header.str(0, 27) === 'SNES-SPC700 Sound File Data' &&
    size >= 0x10180
  )
    return 'SPC';
  if (/\.dsp$/i.test(name) && bytes.length >= 96) {
    const samples = header.u32(0, false),
      nibbles = header.u32(4, false),
      rate = header.u32(8, false);
    if (
      samples > 0 &&
      nibbles >= samples &&
      nibbles <= Math.ceil(samples / 14) * 16 &&
      rate >= 1000 &&
      rate <= 192000 &&
      header.u16(12, false) <= 1 &&
      header.u16(14, false) === 0 &&
      96 + Math.ceil(nibbles / 2) <= size
    )
      return 'DSP';
  }
  return null;
}
