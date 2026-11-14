import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_transport.dart';
import '../../core/nod_errors.dart';
import '../../core/schedules.dart';
import '../../core/tasks.dart';
import '../scheduled/scheduled_page.dart' show scheduleDate;
import '../usage/usage_summary.dart' show usageMoney;

class NodTaskSchedulePage extends StatefulWidget {
  const NodTaskSchedulePage({
    required this.transport,
    required this.taskId,
    super.key,
  });
  final NodApiTransport transport;
  final String taskId;

  @override
  State<NodTaskSchedulePage> createState() => _NodTaskSchedulePageState();
}

class _NodTaskSchedulePageState extends State<NodTaskSchedulePage> {
  final _form = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _prompt = TextEditingController();
  final _zone = TextEditingController();
  bool _loading = true;
  bool _busy = false;
  bool _submitted = false;
  bool _omittedSensitive = false;
  bool _hasAttachments = false;
  String? _error;
  String? _frequency;
  int _day = 1;
  TimeOfDay _time = const TimeOfDay(hour: 9, minute: 0);
  NodSchedule? _saved;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final draft = taskMap(
        await widget.transport.requestJson(
          'GET',
          '/api/tasks/${Uri.encodeComponent(widget.taskId)}/schedule-draft',
        ),
      );
      if (!mounted) return;
      _title.text = taskText(draft, 'title');
      _prompt.text = taskText(draft, 'prompt');
      _omittedSensitive = draft['omittedSensitive'] == true;
      _hasAttachments = draft['hasAttachments'] == true;
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is NodException
              ? error.message
              : 'Could not load the original task requests.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String? _required(String? value) =>
      value == null || value.trim().isEmpty ? 'Enter a value.' : null;

  Future<void> _save() async {
    if (_submitted || !_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _submitted = true;
      _error = null;
    });
    final suffix = switch (_frequency) {
      'daily' => '* * *',
      'weekdays' => '* * 1-5',
      'weekly' => '* * $_day',
      'monthly' => '$_day * *',
      _ => throw StateError('Choose a frequency'),
    };
    try {
      final saved = NodSchedule.fromJson(
        taskMap(
          await widget.transport.requestJson(
            'POST',
            '/api/schedules',
            body: {
              'title': _title.text.trim(),
              'prompt': _prompt.text.trim(),
              'kind': 'recurring',
              'cron': '${_time.minute} ${_time.hour} $suffix',
              'timeZone': _zone.text.trim(),
            },
          ),
        ),
      );
      if (mounted) setState(() => _saved = saved);
    } catch (error) {
      if (mounted) {
        setState(
          () => _error =
              '${error is NodException ? error.message : 'Could not save the schedule.'} Check Scheduled before creating another schedule. This request will not be retried.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _title.dispose();
    _prompt.dispose();
    _zone.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final saved = _saved;
    return Scaffold(
      appBar: AppBar(title: const Text('Schedule task')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (_loading || _busy) const LinearProgressIndicator(),
          if (_error != null && !_submitted) Text(_error!),
          if (saved != null) ...[
            Text(
              'Scheduled ${saved.title}',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            SelectableText(saved.prompt),
            Text('${saved.cron} · ${saved.timeZone}'),
            if (saved.nextRun != null)
              Text(
                'Next run ${scheduleDate(context, saved.nextRun!)} (device time)',
              ),
            if (saved.monthlyUsd != null)
              Text('Projected cost ≈ ${usageMoney(saved.monthlyUsd!)} / month'),
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'),
            ),
          ] else if (!_loading && _error != null && _title.text.isEmpty) ...[
            TextButton(onPressed: _load, child: const Text('Try again')),
          ] else if (!_loading)
            Form(
              key: _form,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'Review the original requests and adapt them for future runs. The instructions authorize future schedule actions.',
                  ),
                  if (_omittedSensitive)
                    const Text(
                      'Messages with sensitive details and sign-in codes were left out. Review the remaining instructions.',
                    ),
                  if (_hasAttachments)
                    const Text(
                      'Attachments are not added to this schedule. Include the details each run needs.',
                    ),
                  TextFormField(
                    controller: _title,
                    enabled: !_submitted,
                    decoration: const InputDecoration(labelText: 'Name'),
                    validator: _required,
                  ),
                  TextFormField(
                    controller: _prompt,
                    enabled: !_submitted,
                    decoration: const InputDecoration(
                      labelText: 'Instructions for each run',
                    ),
                    minLines: 3,
                    maxLines: 8,
                    validator: _required,
                  ),
                  DropdownButtonFormField<String>(
                    initialValue: _frequency,
                    decoration: const InputDecoration(labelText: 'Repeat'),
                    items: const [
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(
                        value: 'weekdays',
                        child: Text('Weekdays'),
                      ),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly')),
                      DropdownMenuItem(
                        value: 'monthly',
                        child: Text('Monthly'),
                      ),
                    ],
                    validator: (value) =>
                        value == null ? 'Choose a frequency.' : null,
                    onChanged: _submitted
                        ? null
                        : (value) => setState(() {
                            _frequency = value;
                            _day = 1;
                          }),
                  ),
                  if (_frequency == 'weekly' || _frequency == 'monthly')
                    DropdownButtonFormField<int>(
                      key: ValueKey(_frequency),
                      initialValue: _day,
                      decoration: InputDecoration(
                        labelText: _frequency == 'weekly'
                            ? 'Day'
                            : 'Day of month',
                      ),
                      items: _frequency == 'weekly'
                          ? [
                              for (var day = 0; day < 7; day++)
                                DropdownMenuItem(
                                  value: day,
                                  child: Text(
                                    const [
                                      'Sunday',
                                      'Monday',
                                      'Tuesday',
                                      'Wednesday',
                                      'Thursday',
                                      'Friday',
                                      'Saturday',
                                    ][day],
                                  ),
                                ),
                            ]
                          : [
                              for (var day = 1; day <= 31; day++)
                                DropdownMenuItem(
                                  value: day,
                                  child: Text('$day'),
                                ),
                            ],
                      onChanged: _submitted
                          ? null
                          : (value) => setState(() => _day = value!),
                    ),
                  ListTile(
                    title: const Text('Run time'),
                    subtitle: Text(_time.format(context)),
                    trailing: const Icon(Icons.schedule),
                    onTap: _submitted
                        ? null
                        : () async {
                            final time = await showTimePicker(
                              context: context,
                              initialTime: _time,
                            );
                            if (time != null && mounted) {
                              setState(() => _time = time);
                            }
                          },
                  ),
                  TextFormField(
                    controller: _zone,
                    enabled: !_submitted,
                    decoration: const InputDecoration(
                      labelText: 'Schedule time zone',
                      helperText: 'IANA name, for example Europe/Berlin or UTC',
                    ),
                    validator: _required,
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'The server validates the timing. Run time uses the schedule time zone, not the device clock.',
                  ),
                  if (_error != null && _submitted) Text(_error!),
                  FilledButton(
                    onPressed: _submitted ? null : _save,
                    child: const Text('Create schedule'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
