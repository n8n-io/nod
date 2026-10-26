const sources = new WeakMap<File, File>();

export function recordingSource(file: File) {
  return sources.get(file) ?? file;
}

export function preserveRecordingSource(file: File, source: File) {
  sources.set(file, recordingSource(source));
}
