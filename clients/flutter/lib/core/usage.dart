class NodUsageCursor {
  const NodUsageCursor({required this.at, required this.id});
  final String at;
  final String id;
}

class NodUsageEntry {
  const NodUsageEntry({
    required this.id,
    required this.at,
    required this.title,
    required this.source,
    required this.costUsd,
    required this.models,
    required this.actions,
    this.error,
    this.pricing,
  });
  final String id;
  final DateTime at;
  final String title;
  final String source;
  final double? costUsd;
  final List<String> models;
  final List<String> actions;
  final String? error;
  final String? pricing;

  factory NodUsageEntry.fromJson(Map<String, Object?> json) => NodUsageEntry(
    id: _text(json['id']),
    at: DateTime.parse(_text(json['at'])),
    title: _text(json['title']),
    source: _text(json['source']),
    costUsd: json['costUsd'] == null ? null : _amount(json['costUsd']),
    error: json['error'] as String?,
    pricing: json['pricing'] as String?,
    models: _list(json['models']).map((value) {
      final model = _map(value);
      return '${model['model'] as String? ?? 'Model not recorded'} · ${model['billing'] == 'plan' ? 'ChatGPT plan' : '${model['provider'] as String? ?? 'Model'} API'}';
    }).toList(),
    actions: _list(json['actions']).map((value) {
      final action = _map(value);
      final because = action['because'] == null
          ? null
          : _map(action['because']);
      final reason = because == null
          ? null
          : because['kind'] == 'approved'
          ? 'Approved by you'
          : because['text'] as String?;
      return [_text(action['label']), ?reason].join(' · ');
    }).toList(),
  );
}

class NodUsageEntries {
  const NodUsageEntries({required this.entries, this.next});
  final List<NodUsageEntry> entries;
  final NodUsageCursor? next;
  factory NodUsageEntries.fromJson(Map<String, Object?> json) {
    final next = json['next'] == null ? null : _map(json['next']);
    return NodUsageEntries(
      entries: _list(json['entries'])
          .map((entry) => NodUsageEntry.fromJson(_map(entry)))
          .toList(),
      next: next == null
          ? null
          : NodUsageCursor(at: _text(next['at']), id: _text(next['id'])),
    );
  }
}

class NodUsageLimit {
  const NodUsageLimit({required this.monthlyUsd, required this.reached});
  final double monthlyUsd;
  final bool reached;
  factory NodUsageLimit.fromJson(Map<String, Object?> json) {
    final amount = _amount(json['monthlyUsd']);
    if (amount < 1) throw const FormatException('Invalid monthly limit');
    return NodUsageLimit(monthlyUsd: amount, reached: json['reached'] as bool);
  }
}

class NodUsageReport {
  const NodUsageReport({
    required this.start,
    required this.days,
    required this.elapsedDays,
    required this.spentUsd,
    required this.forecastUsd,
    required this.planUsd,
    required this.planUsage,
    required this.unpriced,
    required this.daily,
    required this.page,
    required this.limit,
  });
  final DateTime start;
  final int days;
  final double elapsedDays;
  final double spentUsd;
  final double forecastUsd;
  final double planUsd;
  final bool planUsage;
  final bool unpriced;
  final List<double> daily;
  final NodUsageEntries page;
  final NodUsageLimit? limit;

  NodUsageReport withLimit(NodUsageLimit? value) => NodUsageReport(
    start: start,
    days: days,
    elapsedDays: elapsedDays,
    spentUsd: spentUsd,
    forecastUsd: forecastUsd,
    planUsd: planUsd,
    planUsage: planUsage,
    unpriced: unpriced,
    daily: daily,
    page: page,
    limit: value,
  );

  factory NodUsageReport.fromJson(Map<String, Object?> json) {
    final month = _map(json['month']);
    final days = month['days'] as int;
    final elapsedDays = _amount(month['elapsedDays']);
    if (days < 1 || days > 31 || elapsedDays > days) {
      throw const FormatException('Invalid usage period');
    }
    return NodUsageReport(
      start: DateTime.parse(_text(month['start'])),
      days: days,
      elapsedDays: elapsedDays,
      spentUsd: _amount(month['spentUsd']),
      forecastUsd: _amount(month['forecastUsd']),
      planUsd: _amount(month['planUsd']),
      planUsage: month['planUsage'] as bool,
      unpriced: month['unpriced'] as bool,
      daily: _list(month['daily']).map(_amount).toList(),
      page: NodUsageEntries.fromJson(json),
      limit: json['limit'] == null
          ? null
          : NodUsageLimit.fromJson(_map(json['limit'])),
    );
  }
}

abstract interface class NodUsageRepository {
  Future<NodUsageReport> loadUsage();
  Future<NodUsageEntries> loadUsageEntries(NodUsageCursor cursor);
  Future<NodUsageLimit?> saveMonthlyLimit(double? monthlyUsd);
}

Map<String, Object?> _map(Object? value) =>
    Map<String, Object?>.from(value as Map);
List<Object?> _list(Object? value) => value as List<Object?>;
String _text(Object? value) => value as String;
double _amount(Object? value) {
  final amount = (value as num).toDouble();
  if (!amount.isFinite || amount < 0) {
    throw const FormatException('Invalid usage amount');
  }
  return amount;
}
