export const cseqDriverRate = 192.03;
export const cseqSilence = -723 * 128;

const attackTable = [
  0, 1, 5, 14, 26, 38, 51, 63, 73, 84, 92, 100, 109, 116, 123, 127, 132, 137,
  143,
];
const sustainTable = [
  -32768, -722, -721, -651, -601, -562, -530, -503, -480, -460, -442, -425,
  -410, -396, -383, -371, -360, -349, -339, -330, -321, -313, -305, -297, -289,
  -282, -276, -269, -263, -257, -251, -245, -239, -234, -229, -224, -219, -214,
  -210, -205, -201, -196, -192, -188, -184, -180, -176, -173, -169, -165, -162,
  -158, -155, -152, -149, -145, -142, -139, -136, -133, -130, -127, -125, -122,
  -119, -116, -114, -111, -109, -106, -103, -101, -99, -96, -94, -91, -89, -87,
  -85, -82, -80, -78, -76, -74, -72, -70, -68, -66, -64, -62, -60, -58, -56,
  -54, -52, -50, -49, -47, -45, -43, -42, -40, -38, -36, -35, -33, -31, -30,
  -28, -27, -25, -23, -22, -20, -19, -17, -16, -14, -13, -11, -10, -8, -7, -6,
  -4, -3, -1, 0,
];
const sineTable = [
  0, 6, 12, 19, 25, 31, 37, 43, 49, 54, 60, 65, 71, 76, 81, 85, 90, 94, 98, 102,
  106, 109, 112, 115, 117, 120, 122, 123, 125, 126, 126, 127, 127,
];

export const cseqSigned8 = (value: number) => ((value + 128) & 255) - 128;
export const cseqSigned16 = (value: number) =>
  ((value + 32768) & 65535) - 32768;
export function cseqAttack(value: number) {
  value = value & 128 ? 0 : value & 127;
  return value >= 109 ? attackTable[127 - value] : 255 - value;
}
export function cseqFall(value: number) {
  value = value & 128 ? 0 : value & 127;
  if (value === 127) return 65535;
  if (value === 126) return 15360;
  return value < 50 ? value * 2 + 1 : Math.trunc(7680 / (126 - value));
}
export function cseqSustain(value: number) {
  return sustainTable[
    value & 128 ? 127 : Math.max(0, Math.min(127, Math.trunc(value)))
  ];
}
export function cseqSine(value: number) {
  value &= 127;
  if (value <= 32) return sineTable[value];
  if (value <= 64) return sineTable[64 - value];
  if (value <= 96) return -sineTable[value - 64];
  return -sineTable[128 - value];
}
