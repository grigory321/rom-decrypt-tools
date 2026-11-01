const U32_MASK64 = BigInt(2 ** 32 - 1);

const _32n = BigInt(32);

function fromBig(n, le = false) {
  if (le) {
    return {
      h: Number(n & U32_MASK64),
      l: Number((n >> _32n) & U32_MASK64),
    };
  }
  return {
    h: Number((n >> _32n) & U32_MASK64) | 0,
    l: Number(n & U32_MASK64) | 0,
  };
}

function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h: h, l: l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}

const toBig = (h, l) => (BigInt(h >>> 0) << _32n) | BigInt(l >>> 0);

const shrSH = (h, _l, s) => h >>> s;

const shrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);

const rotrSH = (h, l, s) => (h >>> s) | (l << (32 - s));

const rotrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);

const rotrBH = (h, l, s) => (h << (64 - s)) | (l >>> (s - 32));

const rotrBL = (h, l, s) => (h >>> (s - 32)) | (l << (64 - s));

const rotr32H = (_h, l) => l;

const rotr32L = (h, _l) => h;

const rotlSH = (h, l, s) => (h << s) | (l >>> (32 - s));

const rotlSL = (h, l, s) => (l << s) | (h >>> (32 - s));

const rotlBH = (h, l, s) => (l << (s - 32)) | (h >>> (64 - s));

const rotlBL = (h, l, s) => (h << (s - 32)) | (l >>> (64 - s));

function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return {
    h: (Ah + Bh + ((l / 2 ** 32) | 0)) | 0,
    l: l | 0,
  };
}

const add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);

const add3H = (low, Ah, Bh, Ch) => (Ah + Bh + Ch + ((low / 2 ** 32) | 0)) | 0;

const add4L = (Al, Bl, Cl, Dl) =>
  (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);

const add4H = (low, Ah, Bh, Ch, Dh) =>
  (Ah + Bh + Ch + Dh + ((low / 2 ** 32) | 0)) | 0;

const add5L = (Al, Bl, Cl, Dl, El) =>
  (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);

const add5H = (low, Ah, Bh, Ch, Dh, Eh) =>
  (Ah + Bh + Ch + Dh + Eh + ((low / 2 ** 32) | 0)) | 0;

export {
  add,
  add3H,
  add3L,
  add4H,
  add4L,
  add5H,
  add5L,
  fromBig,
  rotlBH,
  rotlBL,
  rotlSH,
  rotlSL,
  rotr32H,
  rotr32L,
  rotrBH,
  rotrBL,
  rotrSH,
  rotrSL,
  shrSH,
  shrSL,
  split,
  toBig,
};

const u64 = {
  fromBig: fromBig,
  split: split,
  toBig: toBig,
  shrSH: shrSH,
  shrSL: shrSL,
  rotrSH: rotrSH,
  rotrSL: rotrSL,
  rotrBH: rotrBH,
  rotrBL: rotrBL,
  rotr32H: rotr32H,
  rotr32L: rotr32L,
  rotlSH: rotlSH,
  rotlSL: rotlSL,
  rotlBH: rotlBH,
  rotlBL: rotlBL,
  add: add,
  add3L: add3L,
  add3H: add3H,
  add4L: add4L,
  add4H: add4H,
  add5H: add5H,
  add5L: add5L,
};

export default u64;
