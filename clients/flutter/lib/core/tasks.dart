import 'nod_errors.dart';

Map<String, dynamic> taskMap(Object? value) {
  if (value is! Map<String, dynamic>) throw const NodProtocolException();
  return value;
}

String taskText(Map<String, dynamic> json, String key) {
  if (json[key] is! String) throw const NodProtocolException();
  return json[key] as String;
}

String? taskOptionalText(Map<String, dynamic> json, String key) =>
    json[key] == null ? null : taskText(json, key);

List<String> taskStrings(Object? value) {
  if (value is! List || value.any((item) => item is! String)) {
    throw const NodProtocolException();
  }
  return value.cast<String>();
}

class NodTask {
  NodTask.fromJson(Map<String, dynamic> json)
    : id = taskText(json, 'id'),
      title = taskText(json, 'title'),
      status = taskText(json, 'status'),
      now = taskText(json, 'now'),
      result = taskText(json, 'result'),
      doneWhen = taskText(json, 'doneWhen'),
      question = taskOptionalText(json, 'question'),
      questionMessageId = taskOptionalText(json, 'questionMessageId'),
      messageId = taskOptionalText(json, 'messageId'),
      nextCheck = taskOptionalText(json, 'nextCheck'),
      createdAt = taskText(json, 'createdAt'),
      browserHandoff = json['browserHandoff'] == true,
      steps = taskStrings(json['steps'] ?? []),
      stepIndex = json['stepIndex'] is int ? json['stepIndex'] as int : 0,
      updateQueued =
          (json['revision'] as int? ?? 0) >
          (json['appliedRevision'] as int? ?? 0),
      waitingFor = (json['waitingFor'] as List).map((item) {
        final wait = taskMap(item);
        return (who: taskText(wait, 'who'), via: taskText(wait, 'via'));
      }).toList() {
    if (!labels.containsKey(status)) throw const NodProtocolException();
  }

  static const labels = {
    'queued': 'Queued',
    'working': 'Working',
    'needs_you': 'Needs you',
    'waiting': 'Waiting',
    'scheduled': 'Checking back',
    'failed': 'Failed',
    'done': 'Done',
    'cancelled': 'Stopped',
  };
  final String id, title, status, now, result, doneWhen, createdAt;
  final String? question, questionMessageId, messageId, nextCheck;
  final bool browserHandoff, updateQueued;
  final List<String> steps;
  final int stepIndex;
  final List<({String who, String via})> waitingFor;
  bool get closed => status == 'done' || status == 'cancelled';
  String? get replyTarget => questionMessageId ?? messageId;
  String get statusLabel => labels[status]!;
}

class NodTaskEvent {
  NodTaskEvent.fromJson(Map<String, dynamic> json)
    : id = taskText(json, 'id'),
      type = taskText(json, 'type'),
      summary = taskText(json, 'summary'),
      site = taskOptionalText(json, 'site'),
      helper = json['parentRunId'] != null;
  final String id, type, summary;
  final String? site;
  final bool helper;
}

class NodTaskDetail {
  NodTaskDetail.fromJson(Map<String, dynamic> json)
    : task = NodTask.fromJson(taskMap(json['task'])),
      events = (json['events'] as List)
          .map((item) => NodTaskEvent.fromJson(taskMap(item)))
          .toList();
  final NodTask task;
  final List<NodTaskEvent> events;
}

class NodTaskReplyContext {
  const NodTaskReplyContext({
    required this.task,
    required this.threadId,
    required this.replyToMessageId,
  });
  final NodTask task;
  final String threadId, replyToMessageId;
}
