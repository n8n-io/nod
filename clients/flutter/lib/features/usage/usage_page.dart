import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/core.dart';
import '../../core/usage.dart';
import '../../design_system/design_system.dart';
import 'usage_activity.dart';
import 'usage_summary.dart';

export 'usage_summary.dart' show usageMoney;

class NodUsagePage extends StatefulWidget {
  const NodUsagePage({required this.repository, super.key});
  final NodUsageRepository repository;
  @override
  State<NodUsagePage> createState() => _NodUsagePageState();
}

class _NodUsagePageState extends State<NodUsagePage>
    with WidgetsBindingObserver {
  final _limitInput = TextEditingController();
  final _limitFocus = FocusNode();
  Timer? _refreshTimer;
  Timer? _eventDebounce;
  StreamSubscription<NodEvent>? _events;
  bool _foreground = true;
  bool _limitDirty = false;
  bool _olderLoaded = false;
  NodUsageReport? _report;
  final _entries = <NodUsageEntry>[];
  NodUsageCursor? _next;
  bool _loading = false;
  bool _paging = false;
  bool _saving = false;
  String? _error;
  String? _pageError;
  String? _limitMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _startRefresh();
    if (widget.repository case final NodRepository repository) {
      _events = repository.events.listen((event) {
        if (event is NodRefreshEvent || event is NodActivityEvent) {
          _eventDebounce ??= Timer(const Duration(seconds: 2), () {
            _eventDebounce = null;
            if (_foreground) unawaited(_load(automatic: true));
          });
        }
      }, onError: (Object error) {});
    }
    unawaited(_load());
  }

  void _startRefresh() {
    _refreshTimer?.cancel();
    if (_foreground) {
      _refreshTimer = Timer.periodic(
        const Duration(seconds: 30),
        (_) => unawaited(_load(automatic: true)),
      );
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _startRefresh();
    if (_foreground) unawaited(_load(automatic: true));
  }

  Future<void> _load({bool automatic = false}) async {
    if (_loading ||
        _paging ||
        _saving ||
        (automatic && (!_foreground || _limitDirty || _limitFocus.hasFocus))) {
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final report = await widget.repository.loadUsage();
      if (!mounted) return;
      setState(() {
        _report = report;
        final older = automatic && _olderLoaded && report.page.next != null
            ? _entries
                  .where(
                    (entry) =>
                        report.page.entries.isNotEmpty &&
                        !entry.at.isAfter(report.page.entries.last.at),
                  )
                  .toList()
            : <NodUsageEntry>[];
        final ids = report.page.entries.map((entry) => entry.id).toSet();
        _entries
          ..clear()
          ..addAll(report.page.entries)
          ..addAll(older.where((entry) => ids.add(entry.id)));
        if (!automatic || !_olderLoaded || report.page.next == null) {
          _next = report.page.next;
          _olderLoaded = false;
        }
        _pageError = null;
        if (!_limitDirty) {
          _limitInput.text = report.limit?.monthlyUsd.toString() ?? '';
        }
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not load usage. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _more() async {
    final cursor = _next;
    if (cursor == null || _paging || _loading || _saving) return;
    setState(() {
      _paging = true;
      _pageError = null;
    });
    try {
      final page = await widget.repository.loadUsageEntries(cursor);
      if (!mounted) return;
      setState(() {
        final ids = _entries.map((entry) => entry.id).toSet();
        _entries.addAll(page.entries.where((entry) => ids.add(entry.id)));
        _olderLoaded = true;
        _next = page.next;
      });
    } catch (_) {
      if (mounted) {
        setState(() => _pageError = 'Could not load more activity. Try again.');
      }
    } finally {
      if (mounted) setState(() => _paging = false);
    }
  }

  Future<void> _save(double? value) async {
    if (_saving || _loading || _paging) return;
    setState(() {
      _saving = true;
      _limitMessage = null;
    });
    try {
      final limit = await widget.repository.saveMonthlyLimit(value);
      if (!mounted) return;
      setState(() {
        _report = _report!.withLimit(limit);
        _limitDirty = false;
        _limitInput.text = limit?.monthlyUsd.toString() ?? '';
        _limitMessage = limit == null
            ? 'Monthly limit removed.'
            : 'Monthly limit saved.';
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => _limitMessage = 'Could not confirm the change. Refresh usage to check the saved limit before trying again.',
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _submit() {
    final value = double.tryParse(_limitInput.text.trim());
    if (value == null || !value.isFinite || value < 1) {
      setState(() => _limitMessage = 'Enter a limit of at least \$1.');
      return;
    }
    unawaited(_save(value));
  }

  Future<void> _remove() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove monthly limit?'),
        content: const Text(
          'New requests will no longer pause at a monthly spending limit.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep limit'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove limit'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted) await _save(null);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    _eventDebounce?.cancel();
    unawaited(_events?.cancel());
    _limitFocus.dispose();
    _limitInput.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final report = _report;
    final theme = Theme.of(context);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        key: const Key('usage-page'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(NodSpacing.lg),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_loading && report == null)
                    const LinearProgressIndicator(),
                  if (_error != null) ...[
                    const SizedBox(height: NodSpacing.md),
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        _error!,
                        style: TextStyle(color: theme.colorScheme.error),
                      ),
                    ),
                    TextButton(
                      onPressed: _loading ? null : _load,
                      child: const Text('Try again'),
                    ),
                  ],
                  if (report != null) ...[
                    UsageSummary(report: report),
                    if (report.planUsage || report.unpriced)
                      ExpansionTile(
                        tilePadding: EdgeInsets.zero,
                        leading: const Icon(Icons.info_outline, size: 20),
                        title: const Text('How usage is counted'),
                        children: [
                          if (report.planUsage)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Text(
                                'ChatGPT plan usage is separate from API spending. Its estimated API-price equivalent is ${usageMoney(report.planUsd)}; this is not an additional charge.',
                              ),
                            ),
                          if (report.unpriced)
                            const Padding(
                              padding: EdgeInsets.only(bottom: 12),
                              child: Text(
                                'Some usage has no recorded price, such as local or free models. It is not included in API spending.',
                              ),
                            ),
                        ],
                      ),
                    const SizedBox(height: NodSpacing.sm),
                    ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      title: const Text('Manage monthly limit'),
                      children: [
                        const Text(
                          'At the limit, new requests pause until next month. Only paid usage counts.',
                        ),
                        const SizedBox(height: NodSpacing.md),
                        TextField(
                          key: const Key('usage-monthly-limit'),
                          controller: _limitInput,
                          focusNode: _limitFocus,
                          enabled: !_saving && !_loading && !_paging,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: const InputDecoration(
                            labelText: 'Monthly limit in US dollars',
                            prefixText: '\$',
                          ),
                          onChanged: (_) => _limitDirty = true,
                          onSubmitted: (_) => _submit(),
                        ),
                        const SizedBox(height: NodSpacing.sm),
                        Wrap(
                          spacing: 8,
                          children: [
                            FilledButton(
                              onPressed: _saving || _loading || _paging
                                  ? null
                                  : _submit,
                              child: Text(_saving ? 'Saving…' : 'Save limit'),
                            ),
                            if (report.limit != null)
                              TextButton(
                                onPressed: _saving || _loading || _paging
                                    ? null
                                    : _remove,
                                child: const Text('Remove limit'),
                              ),
                          ],
                        ),
                        if (_limitMessage != null)
                          Semantics(
                            liveRegion: true,
                            child: Text(_limitMessage!),
                          ),
                        const SizedBox(height: NodSpacing.md),
                      ],
                    ),
                    ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      title: const Text('Daily API spending'),
                      children: [
                        for (
                          var index = 0;
                          index < report.daily.length;
                          index++
                        )
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              vertical: NodSpacing.sm,
                            ),
                            child: Row(
                              children: [
                                Expanded(child: Text('Day ${index + 1}')),
                                Text(usageMoney(report.daily[index])),
                              ],
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: NodSpacing.lg),
                    Text('Activity', style: theme.textTheme.titleLarge),
                    const SizedBox(height: NodSpacing.sm),
                    if (_entries.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: NodSpacing.lg),
                        child: Text(
                          'No activity yet. Your requests and their recorded costs will appear here.',
                        ),
                      ),
                    for (final entry in _entries) ...[
                      UsageActivityTile(key: ValueKey(entry.id), entry: entry),
                      const Divider(height: 1),
                    ],
                    if (_pageError != null)
                      Text(
                        _pageError!,
                        style: TextStyle(color: theme.colorScheme.error),
                      ),
                    if (_next != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: NodSpacing.md,
                        ),
                        child: OutlinedButton(
                          onPressed: _paging || _loading || _saving
                              ? null
                              : _more,
                          child: Text(
                            _paging
                                ? 'Loading…'
                                : _pageError != null
                                ? 'Retry loading activity'
                                : 'Load more activity',
                          ),
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
