export const formatTime = (n: number) =>
  `${Math.floor(Math.max(0, n) / 60)}:${String(Math.floor(Math.max(0, n) % 60)).padStart(2, '0')}`;

export const formatSize = (size: number) =>
  size >= 1024 ** 3
    ? (size / 1024 ** 3).toFixed(2) + ' GB'
    : size >= 1024 ** 2
      ? (size / 1024 ** 2).toFixed(1) + ' MB'
      : size >= 1024
        ? (size / 1024).toFixed(1) + ' KB'
        : size + ' B';
