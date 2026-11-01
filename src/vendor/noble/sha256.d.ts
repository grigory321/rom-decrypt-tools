export interface Sha256State {
  update(bytes: Uint8Array): Sha256State;
  digest(): Uint8Array;
}

export function sha256(bytes: Uint8Array): Uint8Array;

export namespace sha256 {
  function create(): Sha256State;
}
