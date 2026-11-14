import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/core.dart';
import '../../core/schedules.dart';
import '../../design_system/design_system.dart';
import '../usage/usage_summary.dart' show usageMoney;
import 'schedule_tile.dart';

String scheduleDate(BuildContext context, DateTime date) {
  final local = date.toLocal();
  final material = MaterialLocalizations.of(context);
  return '${material.formatMediumDate(local)} · ${material.formatTimeOfDay(TimeOfDay.fromDateTime(local), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}';
}

class NodScheduledPage extends StatefulWidget {
  const NodScheduledPage({
    required this.repository,
    required this.onOpenChat,
    super.key,
  });
  final NodSchedulesRepository repository;
  final VoidCallback onOpenChat;
  @override
  State<NodScheduledPage> createState() => _NodScheduledPageState();
}

class _NodScheduledPageState extends State<NodScheduledPage>
    with WidgetsBindingObserver {
  List<NodSchedule>? _schedules;
  String? _error;
  bool _loading = false;
  bool _foreground = true;
  bool _editing = false;
  bool _uncertain = false;
  final _busy = <String>{};
  Timer? _timer;
  Timer? _debounce;
  StreamSubscription<NodEvent>? _events;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _timer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_load(automatic: true)),
    );
    if (widget.repository case final NodRepository repository) {
      _events = repository.events.listen((event) {
        if (event is NodRefreshEvent || event is NodActivityEvent) {
          _debounce ??= Timer(const Duration(seconds: 2), () {
            _debounce = null;
            unawaited(_load(automatic: true));
          });
        }
      }, onError: (Object _) {});
    }
    unawaited(_load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) unawaited(_load(automatic: true));
  }

  Future<void> _load({bool automatic = false}) async {
    if (_loading ||
        _busy.isNotEmpty ||
        _editing ||
        (automatic && !_foreground)) {
      return;
    }
    setState(() {
      _loading = true;
      if (!automatic) _error = null;
    });
    try {
      final schedules = await widget.repository.loadSchedules();
      schedules.sort((a, b) {
        final enabled = (a.enabled ? 0 : 1).compareTo(b.enabled ? 0 : 1);
        if (enabled != 0) return enabled;
        return (a.nextRun ?? DateTime(9999)).compareTo(
          b.nextRun ?? DateTime(9999),
        );
      });
      if (mounted) {
        setState(() {
          _schedules = schedules;
          _error = null;
          _uncertain = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Can’t connect right now. Your schedules will update automatically when the connection returns.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _change(
    NodSchedule schedule, {
    Map<String, Object?>? changes,
    bool delete = false,
  }) async {
    if (_loading || _busy.isNotEmpty || _uncertain) return;
    setState(() {
      _busy.add(schedule.id);
      _error = null;
    });
    try {
      if (delete) {
        await widget.repository.deleteSchedule(schedule.id);
        if (mounted) {
          setState(
            () => _schedules!.removeWhere((item) => item.id == schedule.id),
          );
        }
      } else {
        final saved = await widget.repository.updateSchedule(
          schedule,
          changes!,
        );
        if (mounted) {
          setState(() {
            final index = _schedules!.indexWhere(
              (item) => item.id == schedule.id,
            );
            if (index >= 0) _schedules![index] = saved;
          });
        }
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _uncertain = true;
          _error = 'We couldn’t confirm that change. Checking the saved schedule automatically before you can make another change.';
        });
      }
    } finally {
      if (mounted) setState(() => _busy.remove(schedule.id));
    }
  }

  Future<void> _delete(NodSchedule schedule) async {
    _editing = true;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete “${schedule.title}”?'),
        content: const Text(
          'Future runs will be cancelled. This does not undo work already performed.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Keep schedule'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete schedule'),
          ),
        ],
      ),
    );
    _editing = false;
    if (confirmed == true && mounted) await _change(schedule, delete: true);
  }

  Future<void> _edit(NodSchedule schedule) async {
    _editing = true;
    final changes = await showDialog<Map<String, Object?>>(
      context: context,
      builder: (_) => _ScheduleEditor(schedule: schedule),
    );
    _editing = false;
    if (changes != null && mounted) await _change(schedule, changes: changes);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _debounce?.cancel();
    unawaited(_events?.cancel());
    super.dispose();
  }

  Widget _details(NodSchedule schedule, bool disabled) {
    final theme = Theme.of(context);
    final colors = context.nodColors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Divider(color: colors.border, height: NodSpacing.lg),
        Text('Instructions', style: theme.textTheme.titleSmall),
        const SizedBox(height: NodSpacing.xs),
        SelectableText(schedule.prompt),
        if (schedule.watch.isNotEmpty) ...[
          const SizedBox(height: NodSpacing.md),
          Text('Watches for changes', style: theme.textTheme.titleSmall),
          const Text(
            'Runs can skip when these accounts are unchanged after a successful run.',
          ),
          Text('${schedule.watch.length} connected accounts'),
        ],
        if (schedule.baseline case final NodScheduleBaseline baseline) ...[
          const SizedBox(height: NodSpacing.md),
          Text('Saved baseline', style: theme.textTheme.titleSmall),
          SelectableText(baseline.summary),
          if (baseline.value != null) SelectableText(baseline.value!),
          Text(baseline.status == 'verified' ? 'Verified' : 'Unavailable'),
          SelectableText(baseline.sourceUrl),
          Text(
            'Checked ${scheduleDate(context, baseline.checkedAt)} (device time)',
          ),
        ],
        const SizedBox(height: NodSpacing.md),
        Wrap(
          spacing: NodSpacing.md,
          runSpacing: NodSpacing.xs,
          children: [
            Text(
              schedule.timeZone,
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.textSecondary,
              ),
            ),
            if (schedule.monthlyUsd != null)
              Text(
                '≈ ${usageMoney(schedule.monthlyUsd!)} / month',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: colors.textSecondary,
                ),
              ),
          ],
        ),
        if (schedule.cron != null)
          Padding(
            padding: const EdgeInsets.only(top: NodSpacing.xs),
            child: Text(
              'Cron: ${schedule.cron}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.textSecondary,
              ),
            ),
          ),
        if (schedule.kind == 'once' && schedule.runAt != null)
          Text(
            'Scheduled for ${scheduleDate(context, schedule.runAt!)} (device time)',
            style: theme.textTheme.bodySmall,
          ),
        const SizedBox(height: NodSpacing.md),
        Wrap(
          spacing: NodSpacing.xs,
          runSpacing: NodSpacing.xs,
          children: [
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: theme.colorScheme.onSurface,
              ),
              onPressed: disabled || (!schedule.enabled && !schedule.canResume)
                  ? null
                  : () => _change(
                      schedule,
                      changes: {'enabled': !schedule.enabled},
                    ),
              icon: Icon(
                schedule.enabled ? Icons.pause : Icons.play_arrow,
                size: 18,
              ),
              label: Text(schedule.enabled ? 'Pause' : 'Resume'),
            ),
            TextButton.icon(
              style: TextButton.styleFrom(
                foregroundColor: theme.colorScheme.onSurface,
              ),
              onPressed: disabled ? null : () => _edit(schedule),
              icon: const Icon(Icons.edit_outlined, size: 18),
              label: const Text('Edit schedule'),
            ),
            TextButton.icon(
              style: TextButton.styleFrom(
                foregroundColor: theme.colorScheme.error,
              ),
              onPressed: disabled ? null : () => _delete(schedule),
              icon: const Icon(Icons.delete_outline, size: 18),
              label: const Text('Delete'),
            ),
          ],
        ),
        if (_busy.contains(schedule.id)) const LinearProgressIndicator(),
        const SizedBox(height: NodSpacing.lg),
        _ScheduleHistory(
          key: ValueKey(
            '${schedule.id}:${schedule.lastRun?.id}:${schedule.lastRun?.status}',
          ),
          repository: widget.repository,
          scheduleId: schedule.id,
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final schedules = _schedules;
    final disabled = _loading || _busy.isNotEmpty || _uncertain;
    final theme = Theme.of(context);
    final colors = context.nodColors;
    final groups = <String, List<NodSchedule>>{
      'Upcoming':
          schedules?.where((s) => s.enabled && s.nextRun != null).toList() ??
          [],
      'Paused': schedules?.where((s) => !s.enabled).toList() ?? [],
      'Past schedules':
          schedules?.where((s) => s.enabled && s.nextRun == null).toList() ??
          [],
    };
    return ListView(
      padding: const EdgeInsets.all(NodSpacing.lg),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 840),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Scheduled', style: theme.textTheme.headlineMedium),
                const SizedBox(height: NodSpacing.xs),
                Text(
                  'A little planning. More off your plate.',
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: colors.textSecondary,
                  ),
                ),
                const SizedBox(height: NodSpacing.lg),
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(
                      backgroundColor: colors.accent,
                      foregroundColor: theme.colorScheme.onSecondary,
                    ),
                    onPressed: widget.onOpenChat,
                    icon: const Icon(Icons.add, size: 20),
                    label: const Text('Plan something in chat'),
                  ),
                ),
                if (_loading && schedules == null)
                  const Padding(
                    padding: EdgeInsets.only(top: NodSpacing.lg),
                    child: LinearProgressIndicator(),
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: NodSpacing.lg),
                    child: Semantics(
                      liveRegion: true,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            Icons.cloud_off_outlined,
                            color: colors.textSecondary,
                            size: 20,
                          ),
                          const SizedBox(width: NodSpacing.sm),
                          Expanded(
                            child: Text(
                              _error!,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: colors.textSecondary,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                if (schedules != null && schedules.isEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: NodSpacing.xl),
                    padding: const EdgeInsets.symmetric(
                      horizontal: NodSpacing.lg,
                      vertical: NodSpacing.xxl,
                    ),
                    decoration: BoxDecoration(
                      color: colors.surfaceSubtle,
                      borderRadius: BorderRadius.circular(NodRadii.card),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(
                          Icons.event_available_outlined,
                          size: 44,
                          color: colors.textSecondary,
                        ),
                        const SizedBox(height: NodSpacing.lg),
                        Text(
                          'Make room for later',
                          style: theme.textTheme.titleLarge,
                        ),
                        const SizedBox(height: NodSpacing.sm),
                        Text(
                          'A morning briefing, a weekly check-in, a reminder at just the right time. Tell Nod what you need and when.',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: colors.textSecondary,
                          ),
                        ),
                        const SizedBox(height: NodSpacing.lg),
                        const Text('Your schedules will appear here.'),
                      ],
                    ),
                  ),
                for (final group in groups.entries.where(
                  (group) => group.value.isNotEmpty,
                )) ...[
                  const SizedBox(height: NodSpacing.xl),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          group.key,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        '${group.value.length}',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                  if (group.key == 'Upcoming')
                    Padding(
                      padding: const EdgeInsets.only(top: NodSpacing.xxs),
                      child: Text(
                        'Next runs in your device’s local time',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.textSecondary,
                        ),
                      ),
                    ),
                  const SizedBox(height: NodSpacing.md),
                  for (final schedule in group.value)
                    Padding(
                      key: ValueKey(schedule.id),
                      padding: const EdgeInsets.only(bottom: NodSpacing.sm),
                      child: ScheduleTile(
                        schedule: schedule,
                        details: _details(schedule, disabled),
                      ),
                    ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _ScheduleHistory extends StatefulWidget {
  const _ScheduleHistory({
    super.key,
    required this.repository,
    required this.scheduleId,
  });
  final NodSchedulesRepository repository;
  final String scheduleId;
  @override
  State<_ScheduleHistory> createState() => _ScheduleHistoryState();
}

class _ScheduleHistoryState extends State<_ScheduleHistory> {
  final _runs = <NodScheduleRun>[];
  String? _cursor;
  bool _loaded = false;
  bool _loading = false;
  bool _failed = false;
  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final page = await widget.repository.loadScheduleHistory(
        widget.scheduleId,
        cursor: _cursor,
      );
      if (mounted) {
        setState(() {
          final ids = _runs.map((run) => run.id).toSet();
          _runs.addAll(page.runs.where((run) => ids.add(run.id)));
          _cursor = page.nextCursor;
          _loaded = true;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text('Run history', style: Theme.of(context).textTheme.titleSmall),
      if (_loaded && _runs.isEmpty) const Text('No runs yet.'),
      for (final run in _runs)
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text(scheduleDate(context, run.scheduledFor)),
          subtitle: Text(
            '${run.status}${run.costUsd == null ? '' : ' · ${usageMoney(run.costUsd!)}'}',
          ),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: SelectableText(
                run.error ?? run.result ?? 'No result recorded.',
              ),
            ),
          ],
        ),
      if (_failed) const Text('Could not load run history. Try again.'),
      if (_loading) const LinearProgressIndicator(),
      if (!_loaded || _cursor != null || _failed)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            style: TextButton.styleFrom(
              foregroundColor: context.nodColors.accent,
            ),
            onPressed: _loading ? null : _load,
            child: Text(
              _failed
                  ? 'Retry history'
                  : _loaded
                  ? 'Load older runs'
                  : 'Show past runs',
            ),
          ),
        ),
    ],
  );
}

class _ScheduleEditor extends StatefulWidget {
  const _ScheduleEditor({required this.schedule});
  final NodSchedule schedule;
  @override
  State<_ScheduleEditor> createState() => _ScheduleEditorState();
}

class _ScheduleEditorState extends State<_ScheduleEditor> {
  final _form = GlobalKey<FormState>();
  late final _title = TextEditingController(text: widget.schedule.title);
  late final _prompt = TextEditingController(text: widget.schedule.prompt);
  late final _timing = TextEditingController(
    text:
        widget.schedule.cron ??
        widget.schedule.runAt!.toUtc().toIso8601String(),
  );
  late final _zone = TextEditingController(text: widget.schedule.timeZone);
  @override
  void dispose() {
    _title.dispose();
    _prompt.dispose();
    _timing.dispose();
    _zone.dispose();
    super.dispose();
  }

  String? _required(String? value) =>
      value == null || value.trim().isEmpty ? 'Enter a value.' : null;
  void _save() {
    if (!_form.currentState!.validate()) return;
    final schedule = widget.schedule;
    final changes = <String, Object?>{};
    if (_title.text.trim() != schedule.title) {
      changes['title'] = _title.text.trim();
    }
    if (_prompt.text.trim() != schedule.prompt) {
      changes['prompt'] = _prompt.text.trim();
    }
    if (_zone.text.trim() != schedule.timeZone) {
      changes['timeZone'] = _zone.text.trim();
    }
    if (schedule.kind == 'recurring') {
      if (_timing.text.trim() != schedule.cron) {
        changes['cron'] = _timing.text.trim();
      }
    } else {
      final date = DateTime.parse(_timing.text.trim()).toUtc();
      if (date != schedule.runAt) changes['runAt'] = date.toIso8601String();
    }
    Navigator.pop(context, changes.isEmpty ? null : changes);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Edit schedule'),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Form(
          key: _form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: _title,
                decoration: const InputDecoration(labelText: 'Title'),
                validator: _required,
              ),
              const SizedBox(height: NodSpacing.md),
              TextFormField(
                controller: _prompt,
                decoration: const InputDecoration(labelText: 'Instructions'),
                minLines: 3,
                maxLines: 6,
                validator: _required,
              ),
              const SizedBox(height: NodSpacing.md),
              TextFormField(
                controller: _timing,
                decoration: InputDecoration(
                  labelText: widget.schedule.kind == 'once'
                      ? 'Run at (ISO 8601 with time zone)'
                      : 'Cron expression',
                  helperText: widget.schedule.kind == 'once'
                      ? 'Example: 2026-12-01T09:00:00-05:00'
                      : 'Minute hour day month weekday. Example: 0 9 * * 1-5',
                ),
                validator: (value) {
                  if (_required(value) != null) return 'Enter a time.';
                  if (widget.schedule.kind == 'recurring') {
                    return value!.trim().split(RegExp(r'\s+')).length == 5
                        ? null
                        : 'Enter five cron fields.';
                  }
                  final text = value!.trim();
                  final date = DateTime.tryParse(text);
                  if (!RegExp(r'(Z|[+-]\d{2}:\d{2})$').hasMatch(text)) {
                    return 'Include Z or a time-zone offset.';
                  }
                  return date != null &&
                          (date.isAtSameMomentAs(widget.schedule.runAt!) ||
                              date.isAfter(DateTime.now()))
                      ? null
                      : 'Enter a future date and time.';
                },
              ),
              const SizedBox(height: NodSpacing.md),
              TextFormField(
                controller: _zone,
                decoration: const InputDecoration(
                  labelText: 'Schedule time zone',
                  helperText: 'IANA name, for example America/New_York',
                ),
                validator: _required,
              ),
              const SizedBox(height: NodSpacing.md),
              const Text(
                'The server validates the timing when you save. Changing instructions changes what future runs are allowed to do.',
              ),
            ],
          ),
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(onPressed: _save, child: const Text('Save changes')),
    ],
  );
}
