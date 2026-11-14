import 'nod_errors.dart';

abstract interface class NodSchedulesRepository {
  Future<List<NodSchedule>> loadSchedules();
  Future<NodSchedule> updateSchedule(
    NodSchedule schedule,
    Map<String, Object?> changes,
  );
  Future<void> deleteSchedule(String id);
  Future<NodScheduleHistory> loadScheduleHistory(String id, {String? cursor});
}

Map<String, dynamic> scheduleMap(Object? value) {
  if (value is! Map<String, dynamic>) throw const NodProtocolException();
  return value;
}

String _text(Map<String, dynamic> value, String key) {
  final text = value[key];
  if (text is! String || text.isEmpty) throw const NodProtocolException();
  return text;
}

String? _optionalText(Map<String, dynamic> value, String key) {
  if (value[key] == null) return null;
  return _text(value, key);
}

DateTime? _date(Map<String, dynamic> value, String key) {
  final text = _optionalText(value, key);
  if (text == null) return null;
  final date = DateTime.tryParse(text);
  if (date == null) throw const NodProtocolException();
  return date;
}

double? _cost(Object? value) {
  if (value == null) return null;
  if (value is! num || !value.isFinite || value < 0) {
    throw const NodProtocolException();
  }
  return value.toDouble();
}

class NodSchedule {
  NodSchedule.fromJson(Map<String, dynamic> json)
    : id = _text(json, 'id'),
      title = _text(json, 'title'),
      prompt = _text(json, 'prompt'),
      kind = _text(json, 'kind'),
      cron = _optionalText(json, 'cron'),
      runAt = _date(json, 'runAt'),
      timeZone = _text(json, 'timeZone'),
      nextRun = _date(json, 'nextRun'),
      monthlyUsd = _cost(json['monthlyUsd']),
      watch = json['watch'] == null
          ? const []
          : (json['watch'] as List).map((value) {
              if (value is! String) throw const NodProtocolException();
              return value;
            }).toList(),
      baseline = json['baselineObservation'] == null
          ? null
          : NodScheduleBaseline.fromJson(
              scheduleMap(json['baselineObservation']),
            ),
      lastRun = json['lastRun'] == null
          ? null
          : NodScheduleRun.fromJson(scheduleMap(json['lastRun'])),
      enabled = json['enabled'] is bool
          ? json['enabled'] as bool
          : throw const NodProtocolException(),
      revision = json['revision'] is int && (json['revision'] as int) >= 0
          ? json['revision'] as int
          : throw const NodProtocolException() {
    if (!['once', 'recurring'].contains(kind) ||
        (kind == 'once' ? runAt == null : cron == null)) {
      throw const NodProtocolException();
    }
  }
  final String id, title, prompt, kind, timeZone;
  final String? cron;
  final DateTime? runAt, nextRun;
  final bool enabled;
  final int revision;
  final double? monthlyUsd;
  final NodScheduleRun? lastRun;
  final List<String> watch;
  final NodScheduleBaseline? baseline;
  bool get canResume =>
      kind != 'once' || (runAt?.isAfter(DateTime.now()) ?? false);
}

class NodScheduleBaseline {
  NodScheduleBaseline.fromJson(Map<String, dynamic> json)
    : summary = _text(json, 'summary'),
      sourceUrl = _text(json, 'sourceUrl'),
      checkedAt =
          _date(json, 'checkedAt') ?? (throw const NodProtocolException()),
      status = _text(json, 'status'),
      value = _optionalText(json, 'value');
  final String summary, sourceUrl, status;
  final String? value;
  final DateTime checkedAt;
}

class NodScheduleRun {
  NodScheduleRun.fromJson(Map<String, dynamic> json)
    : id = _text(json, 'id'),
      status = _text(json, 'status'),
      scheduledFor =
          _date(json, 'scheduledFor') ?? (throw const NodProtocolException()),
      error = _optionalText(json, 'error'),
      result =
          _optionalText(json, 'messageText') ??
          _optionalText(json, 'messagePreview'),
      costUsd = _cost(json['costUsd']);
  final String id, status;
  final DateTime scheduledFor;
  final String? error, result;
  final double? costUsd;
}

class NodScheduleHistory {
  NodScheduleHistory.fromJson(Map<String, dynamic> json)
    : runs = json['runs'] is List
          ? (json['runs'] as List)
                .map((value) => NodScheduleRun.fromJson(scheduleMap(value)))
                .toList()
          : throw const NodProtocolException(),
      nextCursor = _optionalText(json, 'nextCursor');
  final List<NodScheduleRun> runs;
  final String? nextCursor;
}
