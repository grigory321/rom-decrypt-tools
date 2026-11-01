function constructTable() {
  const table = new Float64Array(512);
  for (let n = 0; n < 512; n++) {
    const k = 0.5 + n;
    const s = Math.sin((Math.PI * k * 1.28) / 1024);
    const t = (Math.cos((Math.PI * k * 2) / 1023) - 1) * 0.5;
    const u = (Math.cos((Math.PI * k * 4) / 1023) - 1) * 0.08;
    table[511 - n] = (s * (t + u + 1)) / k;
  }
  const out = new Int16Array(512);
  for (let phase = 0; phase < 128; phase++) {
    const idx = [phase, phase + 256, 511 - phase, 255 - phase];
    let sum = 0;
    for (const i of idx) sum += table[i];
    const scale = 2048 / sum;
    for (const i of idx) out[i] = Math.floor(table[i] * scale + 0.5);
  }
  return out;
}

export let GAUSS_TABLE = constructTable();

export function setGaussianTable(table) {
  if (table.length !== 512) {
    throw new Error(
      `gaussian table must have 512 entries, got ${table.length}`,
    );
  }
  GAUSS_TABLE = Int16Array.from(table);
}
