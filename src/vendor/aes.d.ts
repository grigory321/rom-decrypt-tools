interface AesCipher {
  encrypt(bytes: Uint8Array): Uint8Array;
  decrypt(bytes: Uint8Array): Uint8Array;
}

interface AesCounter {
  setValue(value: number): void;
  setBytes(bytes: Uint8Array): void;
  increment(): void;
}

declare global {
  var aesjs: {
    AES: new (key: Uint8Array) => AesCipher;
    Counter: new (initial: Uint8Array | number) => AesCounter;
    ModeOfOperation: {
      ctr: new (key: Uint8Array, counter: AesCounter) => AesCipher;
      cbc: new (key: Uint8Array, iv: Uint8Array) => AesCipher;
    };
  };
}

export {};
