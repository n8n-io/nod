import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/app_connections.dart';
import '../../core/core.dart';
import '../../design_system/design_system.dart';
import '../../design_system/nod_flow_dialog.dart';

class NodAppsPage extends StatefulWidget {
  const NodAppsPage({required this.repository, super.key});

  final NodAppsRepository repository;

  @override
  State<NodAppsPage> createState() => _NodAppsPageState();
}

class _NodAppsPageState extends State<NodAppsPage> {
  List<NodAppConnection>? _apps;
  String? _error;
  String _query = '';
  var _loading = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        widget.repository.loadApps(),
        widget.repository.loadApps(catalog: true),
      ]);
      final saved = results[0];
      final slugs = saved.map((app) => app.slug).toSet();
      final apps = [
        ...saved,
        ...results[1].where((app) => !slugs.contains(app.slug)),
      ];
      apps.sort((a, b) {
        final connected = (a.status == 'connected' ? 0 : 1).compareTo(
          b.status == 'connected' ? 0 : 1,
        );
        return connected != 0 ? connected : a.name.compareTo(b.name);
      });
      if (mounted) setState(() => _apps = apps);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not load apps. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _connect(NodAppConnection app) async {
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) =>
          _AppConnectionDialog(repository: widget.repository, app: app),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final visible = _apps
        ?.where(
          (app) => '${app.name} ${app.slug}'.toLowerCase().contains(
            _query.toLowerCase(),
          ),
        )
        .toList();
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(NodSpacing.lg),
        children: [
          Text(
            'Connected apps',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: NodSpacing.sm),
          const Text(
            'Connect an account to give Nod tools for the apps you use. Sign-in and permissions stay in your browser.',
          ),
          const SizedBox(height: NodSpacing.lg),
          TextField(
            decoration: const InputDecoration(
              labelText: 'Search apps',
              prefixIcon: Icon(Icons.search),
            ),
            onChanged: (value) => setState(() => _query = value),
          ),
          const SizedBox(height: NodSpacing.md),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null) ...[
            Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            TextButton(onPressed: _load, child: const Text('Try again')),
          ],
          if (!_loading && visible != null && visible.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: NodSpacing.lg),
              child: Text('No apps found. Try another search.'),
            ),
          for (final app in visible ?? <NodAppConnection>[]) ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: NodSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    app.name,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (app.account != null) Text(app.account!),
                  if (app.description != null)
                    Text(
                      app.description!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  const SizedBox(height: NodSpacing.xs),
                  if (app.status == 'connected') const Text('Connected'),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Theme.of(context).colorScheme.onSurface,
                    ),
                    onPressed: () => _connect(app),
                    icon: const Icon(Icons.link),
                    label: Text(
                      app.status == 'connected'
                          ? 'Add account'
                          : app.connectionId == null
                          ? 'Connect'
                          : 'Reconnect',
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
          ],
        ],
      ),
    );
  }
}

class _AppConnectionDialog extends StatefulWidget {
  const _AppConnectionDialog({required this.repository, required this.app});

  final NodAppsRepository repository;
  final NodAppConnection app;

  @override
  State<_AppConnectionDialog> createState() => _AppConnectionDialogState();
}

enum _Step { review, preparing, ready, waiting, connected, failed }

class _AppConnectionDialogState extends State<_AppConnectionDialog>
    with WidgetsBindingObserver {
  _Step _step = _Step.review;
  NodAppSignIn? _signIn;
  Timer? _poll;
  DateTime? _deadline;
  String? _error;
  var _closing = false;
  var _checking = false;
  var _opening = false;
  var _active = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  Future<void> _cancel(NodAppSignIn signIn) async {
    await widget.repository.cancelAppSignIn(signIn);
  }

  Future<void> _start() async {
    setState(() {
      _step = _Step.preparing;
      _error = null;
    });
    try {
      final previous = _signIn;
      if (previous != null) {
        await _cancel(previous);
        _signIn = null;
      }
      final signIn = await widget.repository.startAppSignIn(widget.app);
      if (!mounted || _closing) {
        await _cancel(signIn);
        return;
      }
      _signIn = signIn;
      _deadline = DateTime.now().add(const Duration(minutes: 10));
      setState(() => _step = _Step.ready);
      await _open();
    } catch (error) {
      if (mounted && !_closing) {
        setState(() {
          _step = _Step.failed;
          _error = error is NodAppSetupException
              ? error.message
              : 'Could not prepare sign-in. Please try again.';
        });
      }
    }
  }

  Future<void> _open() async {
    if (_opening || _signIn == null) return;
    setState(() => _opening = true);
    try {
      final opened = await launchUrl(
        _signIn!.url,
        mode: LaunchMode.externalApplication,
      );
      if (!mounted || _closing) return;
      setState(() {
        _step = opened ? _Step.waiting : _Step.ready;
        _error = opened
            ? null
            : 'Could not open your browser. Try opening sign-in again.';
      });
      if (opened) unawaited(_check());
    } catch (_) {
      if (mounted && !_closing) {
        setState(() => _error = 'Could not open your browser. Try again.');
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _check() async {
    _poll?.cancel();
    if (_checking ||
        _closing ||
        !_active ||
        _signIn == null ||
        _step != _Step.waiting) {
      return;
    }
    if (DateTime.now().isAfter(_deadline!)) {
      setState(() {
        _step = _Step.failed;
        _error = 'Sign-in timed out. Start again with a new link.';
      });
      return;
    }
    _checking = true;
    try {
      final status = await widget.repository.appSignInStatus(_signIn!);
      if (!mounted || _closing) return;
      setState(() {
        _error = null;
        if (status == NodAppSignInStatus.connected) _step = _Step.connected;
        if (status == NodAppSignInStatus.unavailable) {
          _step = _Step.failed;
          _error = 'This sign-in was cancelled or expired. Start again with a new link.';
        }
      });
    } catch (_) {
      if (mounted && !_closing) {
        setState(
          () => _error = 'Could not check the connection. We’ll retry when Nod is reachable.',
        );
      }
    } finally {
      _checking = false;
      if (mounted && !_closing && _active && _step == _Step.waiting) {
        _poll = Timer(const Duration(seconds: 2), () => unawaited(_check()));
      }
    }
  }

  Future<void> _close() async {
    if (_closing) return;
    setState(() => _closing = true);
    _poll?.cancel();
    try {
      if (_signIn != null && _step != _Step.connected) await _cancel(_signIn!);
      if (mounted) Navigator.of(context).pop(_step == _Step.connected);
    } catch (_) {
      if (mounted) {
        setState(() {
          _closing = false;
          _error = 'Could not cancel sign-in. Try again to close safely.';
        });
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (_active) {
      unawaited(_check());
    } else {
      _poll?.cancel();
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final busy = _step == _Step.preparing || _closing || _opening;
    final connected = _step == _Step.connected;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) unawaited(_close());
      },
      child: NodFlowDialog(
        title: connected
            ? '${widget.app.name} connected'
            : 'Connect ${widget.app.name}',
        actions: [
          TextButton(
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.onSurface,
            ),
            onPressed: _closing ? null : _close,
            child: Text(connected ? 'Done' : 'Cancel'),
          ),
          if (_step == _Step.review || _step == _Step.failed)
            FilledButton(
              onPressed: busy ? null : _start,
              child: Text(
                _step == _Step.failed ? 'Start again' : 'Continue to sign-in',
              ),
            ),
          if (_step == _Step.ready || _step == _Step.waiting)
            OutlinedButton(
              style: OutlinedButton.styleFrom(
                foregroundColor: Theme.of(context).colorScheme.onSurface,
              ),
              onPressed: busy ? null : _open,
              child: const Text('Open sign-in'),
            ),
        ],
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(switch (_step) {
              _Step.review =>
                widget.app.broker
                    ? '${widget.app.name} will ask you to allow Composio, the service Nod uses to connect apps. Choose your account and review the permissions in your browser.'
                    : 'Choose your account and review the permissions in your browser. Nod keeps this connection on your server, not on this device.',
              _Step.preparing => 'Preparing a secure sign-in link…',
              _Step.ready => 'Sign-in is ready to open in your browser.',
              _Step.waiting => 'Finish signing in and reviewing permissions in your browser, then return here. Nod will check the connection automatically.',
              _Step.connected => 'Your account is connected. Nod can now use its available tools. You can return to the conversation.',
              _Step.failed =>
                'Sign-in didn’t finish. You can try again with a new link.',
            }),
            if (_step == _Step.waiting || _step == _Step.preparing) ...[
              const SizedBox(height: NodSpacing.lg),
              const LinearProgressIndicator(),
              const SizedBox(height: NodSpacing.sm),
              Semantics(
                liveRegion: true,
                child: Text(
                  _step == _Step.waiting
                      ? 'Waiting for sign-in'
                      : 'Preparing sign-in',
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: NodSpacing.md),
              Semantics(
                liveRegion: true,
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
