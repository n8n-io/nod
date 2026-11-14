enum NodConnectionPhase {
  disconnected,
  connecting,
  connected,
  reconnecting,
  offline,
}

final class NodConnectionState {
  const NodConnectionState({required this.phase, this.detail});

  final NodConnectionPhase phase;
  final String? detail;

  bool get isConnected => phase == NodConnectionPhase.connected;
}
