import 'dart:math';

import 'connection_state.dart';
import 'nod_models.dart';

String newNodClientMessageId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-'
      '${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-'
      '${hex.substring(20)}';
}

abstract interface class NodRepository {
  Stream<NodConnectionState> get connectionStates;

  Stream<NodEvent> get events;

  Future<void> connect(NodConnectionConfig config);

  Future<void> disconnect();

  Future<NodState> loadState();

  Future<NodHistory> loadHistory({String? cursor});

  Future<void> sendText(String text, {required String clientMessageId});

  Future<void> stop();
}
