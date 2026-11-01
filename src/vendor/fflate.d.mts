export class Unzlib {
  constructor(ondata: (bytes: Uint8Array, final: boolean) => void);
  push(bytes: Uint8Array, final?: boolean): void;
}

export class Inflate {
  constructor(ondata: (bytes: Uint8Array, final: boolean) => void);
  push(bytes: Uint8Array, final?: boolean): void;
}
