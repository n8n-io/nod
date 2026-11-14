import 'dart:async';
import 'dart:io';

import '../../../core/attachments.dart';

import '../../../core/core.dart';
import '../chat_models.dart';

final class SentChatText {
  const SentChatText({required this.text, required this.clientMessageId});

  final String text;
  final String clientMessageId;
}

final class FakeNodRepository
    implements NodRepository, ChatQuestionSource, NodAttachmentsRepository {
  FakeNodRepository({
    NodHistory? history,
    NodState? state,
    this.autoAcknowledgeSends = true,
    this.autoCancelStops = true,
  }) : _history = history ?? const NodHistory(messages: <NodMessage>[]),
       _state =
           state ??
           const NodState(
             messages: <NodMessage>[],
             turn: NodTurnState.idle,
             revision: 'fake-1',
           );

  final StreamController<NodConnectionState> _connectionController =
      StreamController<NodConnectionState>.broadcast(sync: true);
  final StreamController<NodEvent> _eventController =
      StreamController<NodEvent>.broadcast(sync: true);
  final StreamController<ChatQuestion?> _questionController =
      StreamController<ChatQuestion?>.broadcast(sync: true);
  final List<Object> _loadErrors = <Object>[];
  final List<Object> _sendErrors = <Object>[];
  final List<Object> _stopErrors = <Object>[];
  NodHistory _history;
  NodState _state;
  int _messageSequence = 0;

  final bool autoAcknowledgeSends;
  final bool autoCancelStops;
  final List<SentChatText> sentTexts = <SentChatText>[];
  int connectCalls = 0;
  int disconnectCalls = 0;
  int loadHistoryCalls = 0;
  int loadStateCalls = 0;
  int stopCalls = 0;
  Completer<void>? loadGate;
  Completer<void>? nextSendGate;
  Completer<void>? uploadGate;
  @override
  bool get attachmentsSupported => true;
  var uploadCalls = 0;
  var cancelledUploads = 0;
  final attachmentSends = <List<NodArtifact>>[];
  final uploaded = <NodArtifact>[];

  @override
  Stream<NodConnectionState> get connectionStates =>
      _connectionController.stream;

  @override
  Stream<NodEvent> get events => _eventController.stream;

  @override
  Stream<ChatQuestion?> get questions => _questionController.stream;

  void queueLoadError(Object error) {
    _loadErrors.add(error);
  }

  void queueSendError(Object error) {
    _sendErrors.add(error);
  }

  void queueStopError(Object error) {
    _stopErrors.add(error);
  }

  void replaceHistory(NodHistory history) {
    _history = history;
  }

  void replaceState(NodState state) {
    _state = state;
  }

  void emitConnection(NodConnectionState connection) {
    _connectionController.add(connection);
  }

  void emitEvent(NodEvent event) {
    _eventController.add(event);
  }

  void emitQuestion(ChatQuestion? question) {
    _questionController.add(question);
  }

  @override
  Future<void> connect(NodConnectionConfig config) async {
    connectCalls += 1;
    emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.connecting),
    );
    emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.connected),
    );
  }

  @override
  Future<void> disconnect() async {
    disconnectCalls += 1;
    emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.disconnected),
    );
  }

  @override
  Future<NodHistory> loadHistory({String? cursor}) async {
    loadHistoryCalls += 1;
    final gate = loadGate;
    if (gate != null) {
      await gate.future;
    }
    _throwNextLoadError();
    return _history;
  }

  @override
  Future<NodState> loadState() async {
    loadStateCalls += 1;
    final gate = loadGate;
    if (gate != null) {
      await gate.future;
    }
    _throwNextLoadError();
    return _state;
  }

  @override
  Future<void> sendText(String text, {required String clientMessageId}) async {
    sentTexts.add(SentChatText(text: text, clientMessageId: clientMessageId));
    final gate = nextSendGate;
    nextSendGate = null;
    if (gate != null) {
      await gate.future;
    }
    if (_sendErrors.isNotEmpty) {
      throw _sendErrors.removeAt(0);
    }
    if (!autoAcknowledgeSends) {
      return;
    }
    _messageSequence += 1;
    final message = NodMessage(
      id: 'sent-$_messageSequence',
      clientMessageId: clientMessageId,
      role: NodMessageRole.owner,
      text: text,
      createdAt: DateTime.now(),
    );
    emitEvent(NodMessageEvent(message));
    emitEvent(const NodActivityEvent(NodTurnState.queued));
  }

  @override
  Future<NodArtifact> uploadAttachment(
    NodUploadFile file, {
    required Future<void> cancelled,
    required void Function(double) onProgress,
  }) async {
    uploadCalls++;
    var aborted = false;
    unawaited(
      cancelled.then((_) {
        aborted = true;
        cancelledUploads++;
      }),
    );
    if (uploadGate != null) await uploadGate!.future;
    if (aborted) throw const NodRequestException();
    onProgress(1);
    final artifact = NodArtifact(
      id: 'c5ed5115-813d-4d3d-a6ce-${uploadCalls.toString().padLeft(12, '0')}',
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    );
    uploaded.add(artifact);
    return artifact;
  }

  @override
  Future<List<NodArtifact>> renewAttachments(List<String> ids) async =>
      uploaded.where((file) => ids.contains(file.id)).toList();

  @override
  Future<void> sendAttachments(
    String text,
    List<NodArtifact> attachments, {
    required String clientMessageId,
  }) async {
    attachmentSends.add(attachments);
    await sendText(text, clientMessageId: clientMessageId);
    emitEvent(
      NodMessageEvent(
        NodMessage(
          id: 'sent-$_messageSequence',
          clientMessageId: clientMessageId,
          role: NodMessageRole.owner,
          text: text,
          attachments: attachments,
          createdAt: DateTime.now(),
        ),
      ),
    );
  }

  @override
  Future<void> downloadAttachment(
    NodArtifact artifact,
    File destination, {
    required Future<void> cancelled,
  }) async {
    await destination.writeAsString('synthetic preview');
  }

  @override
  Future<void> stop() async {
    stopCalls += 1;
    if (_stopErrors.isNotEmpty) {
      throw _stopErrors.removeAt(0);
    }
    if (autoCancelStops) {
      emitEvent(const NodActivityEvent(NodTurnState.cancelled));
    }
  }

  void _throwNextLoadError() {
    if (_loadErrors.isNotEmpty) {
      throw _loadErrors.removeAt(0);
    }
  }

  Future<void> dispose() async {
    await Future.wait<void>(<Future<void>>[
      _connectionController.close(),
      _eventController.close(),
      _questionController.close(),
    ]);
  }
}
