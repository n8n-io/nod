abstract interface class NodConnectionScope {
  int get connectionGeneration;
}

final class NodBinaryResponse {
  const NodBinaryResponse({required this.bytes, required this.mimeType});
  final List<int> bytes;
  final String mimeType;
}

abstract interface class NodBinaryTransport {
  Future<NodBinaryResponse> requestBytes(
    String method,
    String path, {
    Map<String, Object?>? body,
  });
}

abstract interface class NodPairedOrigin {
  Uri? get pairedOrigin;
}

abstract interface class NodApiTransport {
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  });
}
