import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../api/rich_results_repository.dart';
import '../../core/api_transport.dart';
import '../../core/attachments.dart';
import '../../core/audio.dart';
import '../../core/core.dart';
import 'chat_models.dart';

final class ChatController extends ChangeNotifier {
  ChatController(this._repository);

  final NodRepository _repository;
  final List<ChatMessageItem> _messages = <ChatMessageItem>[];
  final List<NodEvent> _pendingEvents = <NodEvent>[];
  final Set<String> _hiddenMessageIds = <String>{};
  int _hiddenMessageCount = 0;
  int _historyVersion = 0;
  DateTime? _historyOldest;
  StreamSubscription<NodEvent>? _eventSubscription;
  StreamSubscription<NodConnectionState>? _connectionSubscription;
  StreamSubscription<ChatQuestion?>? _questionSubscription;
  NodConnectionState _connection = const NodConnectionState(
    phase: NodConnectionPhase.disconnected,
  );
  NodTurnState _turn = NodTurnState.idle;
  ChatQuestion? _question;
  String? _threadId;
  int _focusVersion = 0;
  bool _isFocusing = false;
  ChatMessageItem? _replyTarget;
  final Set<String> _pendingChoices = {};
  List<NodVerificationRequest> _verificationRequests = const [];

  ChatMessageItem? get replyTarget => _replyTarget;
  List<NodVerificationRequest> get verificationRequests =>
      _verificationRequests;
  bool hasChoices(ChatMessageItem message) =>
      _pendingChoices.contains(message.id) && message.answerChoices != null;

  void replyTo(ChatMessageItem message) {
    if (message.isPending || message.isStreaming) return;
    _replyTarget = message;
    _notify();
  }

  NodApiTransport? get transport =>
      _repository is NodApiTransport ? _repository as NodApiTransport : null;
  bool get canReact => _repository is NodApiTransport;

  Future<void> react(ChatMessageItem message, String? reaction) async {
    if (!canReact || message.isPending || message.isStreaming) return;
    try {
      await NodRichResultsRepository(_repository as NodApiTransport)
          .react(message.id, reaction);
      _applyState(await _repository.loadState());
    } on Object catch (error) {
      _failure = _failureFrom(error);
    }
    _notify();
  }

  void clearReply() {
    _replyTarget = null;
    _notify();
  }

  Future<bool> answerChoices(ChatMessageItem message, List<String> ids) async {
    if (!hasChoices(message) || !canCompose) return false;
    final choices = message.answerChoices!;
    final selected = choices.options
        .where((option) => ids.contains(option.id))
        .toList();
    if (selected.isEmpty ||
        selected.length != ids.toSet().length ||
        (!choices.multiple && selected.length != 1)) {
      return false;
    }
    return sendText(
      selected.map((option) => option.answerText).join('\n'),
      replyTarget: message,
      choiceIds: selected.map((option) => option.id).toList(),
    );
  }

  ChatFailure? _failure;
  bool _isLoading = true;
  bool _isSending = false;
  bool _isStopping = false;
  bool _started = false;
  bool _disposed = false;
  String? _retrySignature;
  String? _retryClientId;

  List<ChatMessageItem> get messages => List.unmodifiable(_messages);
  NodConnectionState get connection => _connection;
  NodTurnState get turn => _turn;
  ChatQuestion? get question => _question;
  ChatFailure? get failure => _failure;
  bool get isLoading => _isLoading;
  bool get isSending => _isSending;
  bool get isStopping => _isStopping;

  bool get canCompose =>
      !_isLoading && !_isSending && !_isStopping && !_isFocusing;

  Future<ChatMessageItem?> focusMessage(
    String messageId, {
    bool reply = true,
  }) async {
    final version = ++_focusVersion;
    final threadId = _threadId;
    _failure = null;
    _replyTarget = null;
    _isFocusing = true;
    _notify();
    try {
      final state = await _repository.loadState();
      if (_disposed || version != _focusVersion) return null;
      _applyState(state);
      if (threadId != null && state.threadId != threadId) return null;
      final historyVersion = _historyVersion;
      final repository = _repository;
      final context = repository is NodMessageFocusRepository
          ? await (repository as NodMessageFocusRepository).loadMessageContext(
              messageId,
            )
          : <NodMessage>[];
      if (_disposed || version != _focusVersion) return null;
      if (repository is NodMessageFocusRepository &&
          !context.any((message) => message.id == messageId)) {
        return null;
      }
      final current = await _repository.loadState();
      if (_disposed || version != _focusVersion) return null;
      _applyState(current);
      if (state.threadId != current.threadId ||
          historyVersion != _historyVersion) {
        return null;
      }
      _mergeMessages(context);
      final target = _messages
          .where((message) => message.id == messageId)
          .firstOrNull;
      if (target == null || target.isStreaming || target.isPending) return null;
      if (reply && target.role == NodMessageRole.assistant) {
        _replyTarget = target;
      }
      return target;
    } on Object catch (error) {
      if (!_disposed && version == _focusVersion) {
        _failure = _failureFrom(error);
      }
      return null;
    } finally {
      if (!_disposed && version == _focusVersion) {
        _isFocusing = false;
        _notify();
      }
    }
  }

  void cancelMessageFocus() {
    _focusVersion++;
    _isFocusing = false;
  }

  bool get canStop =>
      _turn == NodTurnState.queued ||
      _turn == NodTurnState.running ||
      _turn == NodTurnState.waiting;

  Future<void> start() async {
    if (_started) {
      return;
    }
    _started = true;
    _connectionSubscription = _repository.connectionStates.listen(
      _applyConnection,
      onError: _handleStreamError,
    );
    _eventSubscription = _repository.events.listen(
      _receiveEvent,
      onError: _handleStreamError,
    );
    if (_repository case final ChatQuestionSource source) {
      _questionSubscription = source.questions.listen(
        _applyQuestion,
        onError: _handleStreamError,
      );
    }
    await _load();
  }

  Future<void> retry() async {
    _failure = null;
    _isLoading = true;
    _notify();
    await _load();
  }

  Future<bool> sendText(
    String text, {
    List<NodArtifact> attachments = const [],
    NodUploadFile? recording,
    ChatMessageItem? replyTarget,
    List<String>? choiceIds,
  }) async {
    final normalized = text.trim();
    if ((normalized.isEmpty && attachments.isEmpty && recording == null) ||
        !canCompose) {
      return false;
    }
    final target = replyTarget ?? _replyTarget;
    final threadId = _threadId;
    if (target != null && threadId == null) {
      return false;
    }
    final customAnswer = target?.answerChoices != null && choiceIds == null;
    final signature = jsonEncode([
      threadId,
      target?.id,
      choiceIds,
      customAnswer,
      normalized,
      recording?.path,
      attachments.map((file) => file.id).toList(),
    ]);
    final clientMessageId = _retrySignature == signature
        ? _retryClientId!
        : newNodClientMessageId();
    _retrySignature = signature;
    _retryClientId = clientMessageId;
    final pending = ChatMessageItem(
      id: 'pending:$clientMessageId',
      clientMessageId: clientMessageId,
      role: NodMessageRole.owner,
      text: recording == null
          ? normalized
          : [
              normalized,
              'Voice message',
            ].where((value) => value.isNotEmpty).join('\n'),
      attachments: attachments,
      replyToMessageId: target?.id,
      createdAt: DateTime.now(),
      isPending: true,
    );
    _failure = null;
    _isSending = true;
    if (_verificationRequests.isEmpty &&
        !RegExp(r'^\d{3,8}$').hasMatch(normalized)) {
      _messages.add(pending);
    }
    _sortMessages();
    _notify();
    try {
      if (target != null) {
        final repository = _repository;
        if (repository is! NodReplyRepository) {
          throw const NodRequestException();
        }
        await (repository as NodReplyRepository).sendReply(
          normalized,
          clientMessageId: clientMessageId,
          threadId: threadId!,
          replyToMessageId: target.id,
          choiceIds: choiceIds,
          customAnswer: customAnswer,
          attachments: attachments,
          recording: recording,
        );
        _pendingChoices.remove(target.id);
        if (_replyTarget?.id == target.id) _replyTarget = null;
      } else if (recording != null) {
        await (_repository as NodAudioRepository).sendAudio(
          normalized,
          recording,
          clientMessageId: clientMessageId,
          attachments: attachments,
        );
      } else if (attachments.isNotEmpty) {
        final repository = _repository;
        if (repository is! NodAttachmentsRepository) {
          throw const NodRequestException();
        }
        await (repository as NodAttachmentsRepository).sendAttachments(
          normalized,
          attachments,
          clientMessageId: clientMessageId,
        );
      } else {
        await _repository.sendText(
          normalized,
          clientMessageId: clientMessageId,
        );
      }
      _retrySignature = null;
      _retryClientId = null;
      return true;
    } on Object catch (error) {
      if (attachments.isNotEmpty || recording != null) {
        try {
          final state = await _repository.loadState();
          _applyState(state);
          if (_messages.any(
            (message) =>
                !message.isPending &&
                (message.clientMessageId == clientMessageId ||
                    message.id == clientMessageId),
          )) {
            _retrySignature = null;
            _retryClientId = null;
            if (target != null) {
              _pendingChoices.remove(target.id);
              if (_replyTarget?.id == target.id) _replyTarget = null;
            }
            return true;
          }
        } catch (_) {}
      }
      _messages.removeWhere((message) => message.id == pending.id);
      if (recording != null && error is NodAudioException && error.retryable) {
        _retrySignature = null;
        _retryClientId = null;
      }
      if (error is NodConflictException) {
        _replyTarget = null;
        _question = null;
        try {
          _applyState(await _repository.loadState());
        } catch (_) {}
      }
      final failure = _failureFrom(error);
      _failure = recording != null && failure.kind == ChatFailureKind.unknown
          ? ChatFailure(
              ChatFailureKind.audio,
              detail: error is NodAudioException
                  ? error.message
                  : const NodAudioException(NodAudioFailure.send).message,
            )
          : failure;
      return false;
    } finally {
      _isSending = false;
      _notify();
    }
  }

  Future<bool> answer(ChatChoice choice) async {
    final question = _question;
    if (question == null) {
      return false;
    }
    final sent = await sendText(choice.value);
    if (sent && _question?.id == question.id) {
      _question = null;
      _notify();
    }
    return sent;
  }

  Future<void> stop() async {
    if (!canStop || _isStopping) {
      return;
    }
    cancelMessageFocus();
    _failure = null;
    _isStopping = true;
    _notify();
    try {
      await _repository.stop();
      _question = null;
      _replyTarget = null;
      _pendingChoices.clear();
      _verificationRequests = const [];
      _turn = NodTurnState.cancelled;
    } on Object catch (error) {
      _failure = _failureFrom(error);
    } finally {
      _isStopping = false;
      _notify();
    }
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait<Object>(<Future<Object>>[
        _repository.loadHistory(),
        _repository.loadState(),
      ]);
      final history = results[0] as NodHistory;
      final state = results[1] as NodState;
      _mergeMessages(history.messages);
      _applyState(state);
      _failure = null;
    } on Object catch (error) {
      _failure = _failureFrom(error);
      if (_failure?.kind == ChatFailureKind.conversationReset) {
        _messages.clear();
        _turn = NodTurnState.idle;
        _question = null;
      }
    } finally {
      _isLoading = false;
      final pendingEvents = List<NodEvent>.of(_pendingEvents);
      _pendingEvents.clear();
      for (final event in pendingEvents) {
        _applyEvent(event, notify: false);
      }
      if (_question != null) {
        _turn = NodTurnState.waiting;
      }
      _notify();
    }
  }

  void _applyConnection(NodConnectionState connection) {
    _connection = connection;
    if (connection.phase == NodConnectionPhase.offline) {
      _failure = ChatFailure(
        ChatFailureKind.offline,
        detail: connection.detail,
      );
    } else if (connection.phase == NodConnectionPhase.connected &&
        _failure?.kind == ChatFailureKind.offline) {
      _failure = null;
    }
    _notify();
  }

  void _receiveEvent(NodEvent event) {
    if (_isLoading) {
      _pendingEvents.add(event);
      return;
    }
    _applyEvent(event);
  }

  void _applyEvent(NodEvent event, {bool notify = true}) {
    switch (event) {
      case NodRefreshEvent(:final state):
        _applyState(state);
      case NodMessageEvent(:final message):
        _mergeMessages(<NodMessage>[message]);
      case NodMessageDeltaEvent(:final messageId, :final text, :final threadId):
        if (threadId == null || _threadId == null || threadId == _threadId) {
          _appendDelta(messageId, text);
        }
      case NodActivityEvent(:final turn):
        _turn = turn;
        if (turn != NodTurnState.waiting) {
          _question = null;
        }
    }
    if (notify) {
      _notify();
    }
  }

  void _applyQuestion(ChatQuestion? question) {
    _question = question;
    if (question != null) {
      _turn = NodTurnState.waiting;
    }
    _notify();
  }

  void _applyState(NodState state) {
    if (_threadId != null &&
        state.threadId != null &&
        _threadId != state.threadId) {
      _messages.clear();
      _hiddenMessageIds.clear();
      _historyOldest = null;
      _historyVersion++;
      _replyTarget = null;
      _question = null;
      _retrySignature = null;
      _retryClientId = null;
    }
    _threadId = state.threadId;
    _pendingChoices
      ..clear()
      ..addAll(state.pendingAnswerChoiceMessageIds);
    _verificationRequests = state.verificationRequests;
    final changed = _hiddenMessageCount != state.hiddenMessageCount;
    _hiddenMessageCount = state.hiddenMessageCount;
    _hiddenMessageIds.addAll(state.hiddenMessageIds);
    final oldest = _messages.where((message) => !message.isPending).firstOrNull;
    if (oldest != null &&
        (_historyOldest == null ||
            oldest.createdAt.isBefore(_historyOldest!))) {
      _historyOldest = oldest.createdAt;
    }
    final capped = state.hiddenMessageCount > state.hiddenMessageIds.length;
    final visibleIds = state.messages.map((message) => message.id).toSet();
    _messages.removeWhere(
      (message) =>
          _hiddenMessageIds.contains(message.id) ||
          _hiddenMessageIds.contains(message.clientMessageId) ||
          (changed &&
              capped &&
              !message.isPending &&
              !visibleIds.contains(message.id)),
    );
    _mergeMessages(state.messages);
    _turn = state.turn;
    if (_replyTarget != null &&
        !_messages.any((message) => message.id == _replyTarget!.id)) {
      _replyTarget = null;
    }
    if (state.turn != NodTurnState.waiting) _question = null;
    if (changed) {
      final version = ++_historyVersion;
      if (capped && _historyOldest != null) {
        unawaited(_reloadVisibleHistory(_historyOldest!, version));
      }
    }
  }

  Future<void> _reloadVisibleHistory(DateTime oldest, int version) async {
    final messages = <NodMessage>[];
    final cursors = <String>{};
    String? cursor;
    try {
      do {
        final page = await _repository.loadHistory(cursor: cursor);
        if (_disposed || version != _historyVersion) return;
        messages.addAll(page.messages);
        cursor = page.nextCursor;
        if (page.messages.isEmpty ||
            page.messages.any(
              (message) => message.createdAt.isBefore(oldest),
            )) {
          break;
        }
      } while (cursor != null && cursors.add(cursor));
      final currentIds = _messages.map((message) => message.id).toSet();
      _mergeMessages(
        messages.where((message) => !currentIds.contains(message.id)),
      );
      _notify();
    } on Object catch (error) {
      if (!_disposed && version == _historyVersion) {
        _failure = _failureFrom(error);
        _notify();
      }
    }
  }

  void _mergeMessages(Iterable<NodMessage> incoming) {
    for (final message in incoming) {
      if (_hiddenMessageIds.contains(message.id) ||
          _hiddenMessageIds.contains(message.clientMessageId)) {
        continue;
      }
      final pendingIndex = _messages.indexWhere(
        (current) =>
            current.isPending &&
            current.clientMessageId != null &&
            (current.clientMessageId == message.clientMessageId ||
                current.clientMessageId == message.id),
      );
      if (pendingIndex >= 0) {
        _messages[pendingIndex] = ChatMessageItem.fromMessage(message);
        continue;
      }
      final index = _messages.indexWhere((current) => current.id == message.id);
      final item = ChatMessageItem.fromMessage(message);
      if (index >= 0) {
        _messages[index] = item;
      } else {
        _messages.add(item);
      }
    }
    _sortMessages();
  }

  void _appendDelta(String messageId, String delta) {
    if (_hiddenMessageIds.contains(messageId)) return;
    final index = _messages.indexWhere((message) => message.id == messageId);
    if (index < 0) {
      _messages.add(
        ChatMessageItem(
          id: messageId,
          role: NodMessageRole.assistant,
          text: delta,
          createdAt: DateTime.now(),
          isStreaming: true,
        ),
      );
    } else {
      final current = _messages[index];
      _messages[index] = current.copyWith(
        text: '${current.text}$delta',
        isStreaming: true,
      );
    }
    _sortMessages();
  }

  void _sortMessages() {
    _messages.sort((left, right) {
      final byTime = left.createdAt.compareTo(right.createdAt);
      if (byTime != 0) {
        return byTime;
      }
      return left.id.compareTo(right.id);
    });
  }

  void _handleStreamError(Object error, StackTrace stackTrace) {
    _failure = _failureFrom(error);
    _notify();
  }

  ChatFailure _failureFrom(Object error) {
    if (error case final ChatRepositoryException exception) {
      return ChatFailure(exception.kind, detail: exception.detail);
    }
    if (error is NodUnauthorizedException || error is NodForbiddenException) {
      return const ChatFailure(ChatFailureKind.unauthorized);
    }
    if (error case NodConflictException(
      kind: NodConflictKind.conversationReset,
    )) {
      return const ChatFailure(ChatFailureKind.conversationReset);
    }
    if (error is NodOfflineException || error is NodTimeoutException) {
      return const ChatFailure(ChatFailureKind.offline);
    }
    return const ChatFailure(ChatFailureKind.unknown);
  }

  void _notify() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_eventSubscription?.cancel());
    unawaited(_connectionSubscription?.cancel());
    unawaited(_questionSubscription?.cancel());
    super.dispose();
  }
}
