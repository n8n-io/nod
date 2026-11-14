import '../../../core/core.dart';
import '../chat_models.dart';

abstract final class ChatFixtures {
  static final baseTime = DateTime.utc(2026, 1, 15, 9);

  static NodMessage ownerMessage({
    String id = 'owner-1',
    String text = 'Summarize the project update.',
    String? clientMessageId,
    Duration offset = Duration.zero,
  }) {
    return NodMessage(
      id: id,
      clientMessageId: clientMessageId,
      role: NodMessageRole.owner,
      text: text,
      createdAt: baseTime.add(offset),
    );
  }

  static NodMessage assistantMessage({
    String id = 'assistant-1',
    String text = 'The project is on track for the planned review.',
    Duration offset = const Duration(minutes: 1),
  }) {
    return NodMessage(
      id: id,
      role: NodMessageRole.assistant,
      text: text,
      createdAt: baseTime.add(offset),
    );
  }

  static NodHistory get history =>
      NodHistory(messages: <NodMessage>[ownerMessage(), assistantMessage()]);

  static NodState state({
    List<NodMessage> messages = const <NodMessage>[],
    NodTurnState turn = NodTurnState.idle,
    String revision = 'revision-1',
  }) {
    return NodState(messages: messages, turn: turn, revision: revision);
  }

  static String get longMessage => List<String>.filled(
    24,
    'A detailed update stays readable across narrow and wide layouts.',
  ).join(' ');

  static const ordinaryQuestion = ChatQuestion(
    id: 'question-choice',
    prompt: 'Which format should I prepare?',
    choices: <ChatChoice>[
      ChatChoice(label: 'Brief', value: 'Prepare a brief version'),
      ChatChoice(label: 'Detailed', value: 'Prepare a detailed version'),
    ],
  );

  static const approvalQuestion = ChatQuestion(
    id: 'question-approval',
    prompt: 'Send the prepared update to the project group?',
    style: ChatQuestionStyle.approval,
    choices: <ChatChoice>[
      ChatChoice(label: 'Approve', value: 'Yes, send it'),
      ChatChoice(label: 'Decline', value: 'No, do not send it'),
    ],
  );
}
