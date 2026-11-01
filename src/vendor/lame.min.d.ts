interface Mp3Encoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}

declare global {
  var lamejs: {
    Mp3Encoder: new (
      channels: number,
      sampleRate: number,
      bitrate: number,
    ) => Mp3Encoder;
  };
}

export {};
