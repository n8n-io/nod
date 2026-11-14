import 'attachments.dart';
import 'rich_results.dart';

enum NodMessageRole { owner, assistant, system }

enum NodTurnState {
  idle,
  queued,
  running,
  waiting,
  succeeded,
  failed,
  cancelled,
}

final class NodConnectionConfig {
  const NodConnectionConfig({required this.origin, required this.token});

  final Uri origin;
  final String token;

  @override
  String toString() =>
      'NodConnectionConfig(origin: $origin, token: [redacted])';
}

final class NodCapabilities {
  const NodCapabilities({
    required this.contractVersion,
    required this.authMode,
  });

  final int contractVersion;
  final String authMode;
}

final class NodSession {
  const NodSession({this.userId});

  final String? userId;
}

final class NodMessage {
  const NodMessage({
    required this.id,
    required this.role,
    required this.text,
    required this.createdAt,
    this.clientMessageId,
    this.turnId,
    this.replyToMessageId,
    this.reaction,
    this.reactions = const [],
    this.presentation,
    this.answerChoices,
    this.answerChoicesPending = false,
    this.attachments = const [],
  });

  final String id;
  final String? clientMessageId;
  final String? turnId;
  final String? replyToMessageId;
  final String? reaction;
  final List<({String actor, String reaction})> reactions;
  final NodRichResult? presentation;
  final NodAnswerChoices? answerChoices;
  final bool answerChoicesPending;
  final List<NodArtifact> attachments;
  final NodMessageRole role;
  final String text;
  final DateTime createdAt;
}

final class NodState {
  const NodState({
    required this.messages,
    required this.turn,
    required this.revision,
    this.threadId,
    this.pendingAnswerChoiceMessageIds = const [],
    this.verificationRequests = const [],
    this.hiddenMessageIds = const [],
    this.hiddenMessageCount = 0,
  });

  final List<NodMessage> messages;
  final String? threadId;
  final List<String> pendingAnswerChoiceMessageIds;
  final List<NodVerificationRequest> verificationRequests;
  final NodTurnState turn;
  final String revision;
  final List<String> hiddenMessageIds;
  final int hiddenMessageCount;
}

final class NodAnswerChoice {
  const NodAnswerChoice({
    required this.id,
    required this.label,
    this.description,
  });

  final String id;
  final String label;
  final String? description;

  String get answerText {
    final detail = description?.trim();
    return detail != null &&
            detail.isNotEmpty &&
            detail.toLowerCase() != label.trim().toLowerCase()
        ? '${label.trim()}: $detail'
        : label.trim();
  }
}

final class NodAnswerChoices {
  const NodAnswerChoices({required this.options, required this.multiple});

  final List<NodAnswerChoice> options;
  final bool multiple;
}

final class NodVerificationRequest {
  const NodVerificationRequest({
    required this.id,
    required this.turnId,
    required this.kind,
  });

  final String id;
  final String turnId;
  final String kind;
}

abstract interface class NodMessageFocusRepository {
  Future<List<NodMessage>> loadMessageContext(String messageId);
}

abstract interface class NodReplyRepository {
  Future<void> sendReply(
    String text, {
    required String clientMessageId,
    required String threadId,
    required String replyToMessageId,
    List<String>? choiceIds,
    bool customAnswer = false,
    List<NodArtifact> attachments = const [],
    NodUploadFile? recording,
  });
}

final class NodHistory {
  const NodHistory({required this.messages, this.nextCursor});

  final List<NodMessage> messages;
  final String? nextCursor;
}

sealed class NodEvent {
  const NodEvent();
}

final class NodRefreshEvent extends NodEvent {
  const NodRefreshEvent(this.state);

  final NodState state;
}

final class NodMessageEvent extends NodEvent {
  const NodMessageEvent(this.message);

  final NodMessage message;
}

final class NodMessageDeltaEvent extends NodEvent {
  const NodMessageDeltaEvent({
    required this.messageId,
    required this.text,
    this.threadId,
    this.turnId,
    this.streamId,
    this.done = false,
  });

  final String messageId;
  final String text;
  final String? threadId;
  final String? turnId;
  final String? streamId;
  final bool done;
}

final class NodActivity {
  const NodActivity({
    required this.turnId,
    this.taskId,
    this.title,
    this.step,
    this.site,
    this.since,
  });

  final String turnId;
  final String? taskId;
  final String? title;
  final String? step;
  final String? site;
  final DateTime? since;
}

final class NodActivityEvent extends NodEvent {
  const NodActivityEvent(this.turn, {this.items = const []});

  final NodTurnState turn;
  final List<NodActivity> items;
}
