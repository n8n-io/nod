import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/prepared_repository.dart';
import '../../core/api_transport.dart';
import '../../core/prepared.dart';
import '../tasks/task_text.dart';

class NodPreparedPage extends StatefulWidget {
  const NodPreparedPage({required this.transport, this.issueId, super.key});
  final NodApiTransport transport;
  final String? issueId;

  @override
  State<NodPreparedPage> createState() => _NodPreparedPageState();
}

class _NodPreparedPageState extends State<NodPreparedPage>
    with WidgetsBindingObserver {
  late final _repository = NodPreparedRepository(widget.transport);
  NodPreparedWork? _work;
  List<NodPreparedFinding>? _findings;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load());
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _work = null;
      _error = null;
    });
    try {
      if (widget.issueId case final String id) {
        final work = await _repository.load(id);
        if (mounted) setState(() => _work = work);
      } else {
        final findings = await _repository.recentFindings();
        if (mounted) setState(() => _findings = findings);
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _work = null;
          _findings = null;
          _error = 'This prepared work is unavailable. Its source may have been removed or replaced, or the connection may be unavailable.';
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openSource(NodPreparedSource source) async {
    if (_loading || source.externalUri == null) return;
    setState(() => _loading = true);
    try {
      final work = await _repository.load(widget.issueId!);
      final current = work.sources.where(
        (item) =>
            item.sourceId == source.sourceId &&
            item.id == source.id &&
            item.version == source.version &&
            item.url == source.url,
      );
      if (!mounted) return;
      setState(() => _work = work);
      if (current.isEmpty) throw StateError('Source changed');
      final opened = await launchUrl(
        current.first.externalUri!,
        mode: LaunchMode.externalApplication,
      );
      if (!opened) throw StateError('Could not open source');
    } catch (_) {
      if (mounted) {
        setState(() {
          _work = null;
          _error = 'This source could not be opened. Refresh to check whether the saved result is still available.';
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final work = _work;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            work?.title ?? 'Prepared work',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null) Text(_error!),
          TextButton(
            onPressed: _loading ? null : _load,
            child: const Text('Refresh'),
          ),
          if (widget.issueId == null) ...[
            const Text(
              'Findings from recent chat. Older findings remain available through their original messages.',
            ),
            if (_findings?.isEmpty == true)
              const Text('No prepared findings in recent chat.'),
            for (final finding in _findings ?? <NodPreparedFinding>[])
              Card(
                child: ListTile(
                  title: Text(
                    finding.text,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push<void>(
                    MaterialPageRoute(
                      builder: (_) => Scaffold(
                        appBar: AppBar(title: const Text('Prepared work')),
                        body: NodPreparedPage(
                          transport: widget.transport,
                          issueId: finding.id,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
          if (work != null) ...[
            Text('Last updated ${work.updatedAt}'),
            if (work.state == 'resolved')
              const Text('This matter is resolved.'),
            if (work.state == 'dismissed')
              const Text('You dismissed this matter.'),
            const SizedBox(height: 16),
            TaskText(text: work.draft, transport: widget.transport),
            if (work.unknowns.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(
                'Needs checking',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              for (final unknown in work.unknowns) SelectableText('• $unknown'),
            ],
            const SizedBox(height: 16),
            Text('Sources', style: Theme.of(context).textTheme.titleMedium),
            for (final source in work.sources)
              ListTile(
                title: Text(source.label),
                subtitle: Text('Checked ${source.checkedAt}'),
                trailing: source.externalUri == null
                    ? null
                    : const Icon(Icons.open_in_new),
                onTap: _loading || source.externalUri == null
                    ? null
                    : () => _openSource(source),
              ),
          ],
        ],
      ),
    );
  }
}
