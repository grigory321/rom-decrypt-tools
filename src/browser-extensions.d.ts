interface SaveFilePickerRequest {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
  showSaveFilePicker?: (
    options?: SaveFilePickerRequest,
  ) => Promise<FileSystemFileHandle>;
}
