import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/connections_management_repository.dart';
import '../../core/connections_management.dart';

class NodConnectionSetupPage extends StatefulWidget {
  const NodConnectionSetupPage({
    required this.repository,
    required this.name,
    this.initialAttempt,
    this.discoveryId,
    super.key,
  });

  final NodConnectionsManagementRepository repository;
  final String name;
  final NodConnectionAttempt? initialAttempt;
  final String? discoveryId;

  @override
  State<NodConnectionSetupPage> createState() => _NodConnectionSetupPageState();
}

class _NodConnectionSetupPageState extends State<NodConnectionSetupPage>
    with WidgetsBindingObserver {
  final _name = TextEditingController();
  final _endpoint = TextEditingController();
  final _account = TextEditingController();
  final _token = TextEditingController();
  final _clientId = TextEditingController();
  final _instance = TextEditingController();
  final Map<String, TextEditingController> _settings = {};
  String _auth = 'oauth';
  bool _clientRequired = false;
  bool _busy = false;
  bool _checking = false;
  bool _active = true;
  bool _closing = false;
  bool _connected = false;
  bool _unavailable = false;
  bool _timedOut = false;
  String? _error;
  String? _id;
  NodConnectionDiscovery? _discovery;
  Uri? _url;
  Timer? _timer;
  DateTime? _deadline;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _id = widget.discoveryId ?? widget.initialAttempt?.discoveryId;
    _url = widget.initialAttempt?.url;
    if (_url != null) {
      _deadline = DateTime.now().add(const Duration(minutes: 15));
    }
    if (_id != null || _url != null) unawaited(_refresh());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (_active) {
      unawaited(_refresh());
    } else {
      _timer?.cancel();
    }
  }

  Future<void> _refresh() async {
    _timer?.cancel();
    if (!mounted ||
        _busy ||
        _checking ||
        _closing ||
        !_active ||
        _connected ||
        _unavailable) {
      return;
    }
    _checking = true;
    try {
      if (_id != null) {
        final discovery = await widget.repository.discovery(_id!);
        if (!mounted || _closing) return;
        if (_url != null &&
            discovery.authorizationUrl != null &&
            _url.toString() != discovery.authorizationUrl) {
          setState(() {
            _unavailable = true;
            _error =
                'Sign-in changed. Close this setup and use the newest request.';
          });
          return;
        }
        if (_discovery == null) {
          _instance.text = discovery.localAddress ?? '';
          _account.text = discovery.name;
          final env = discovery.paths
              .where((p) => p['kind'] == 'cli')
              .expand((p) => p['env'] as List? ?? []);
          for (final name in env) {
            _settings[name as String] = TextEditingController();
          }
        }
        setState(() {
          _discovery = discovery;
          if (discovery.status == 'connected') _connected = true;
          if (discovery.status == 'failed' || discovery.status == 'cancelled') {
            _error = 'Sign-in did not finish. Start again with a new link.';
            _timedOut = true;
          }
          if (_url == null && discovery.authorizationUrl != null) {
            _url = Uri.parse(discovery.authorizationUrl!);
            _deadline = DateTime.now().add(const Duration(minutes: 15));
          }
        });
      } else if (_url != null) {
        final progress = await widget.repository.progress(_url!);
        if (!mounted || _closing) return;
        setState(() {
          _connected = progress == NodConnectionProgress.connected;
          _unavailable = progress == NodConnectionProgress.unavailable;
          if (_unavailable) _error = 'Sign-in expired or was cancelled. Close this setup and connect again.';
        });
      }
      if (_deadline != null &&
          DateTime.now().isAfter(_deadline!) &&
          !_connected) {
        setState(() {
          _timedOut = true;
          _error = 'Sign-in timed out. Start again or cancel this setup.';
        });
      }
    } catch (_) {
      if (mounted && !_closing) {
        setState(
          () => _error =
              'Could not refresh setup. It may have expired. Retry or cancel.',
        );
      }
    } finally {
      _checking = false;
      if (mounted &&
          !_closing &&
          _active &&
          !_connected &&
          !_unavailable &&
          !_timedOut &&
          (_url != null || _discovery?.status == 'pending')) {
        _timer = Timer(const Duration(seconds: 3), () => unawaited(_refresh()));
      }
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy || _checking) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    _timer?.cancel();
    try {
      await action();
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Setup was not confirmed. Check the details and refresh before retrying.',
        );
      }
    } finally {
      if (mounted) {
        _token.clear();
        for (final controller in _settings.values) {
          controller.clear();
        }
      }
      if (mounted) setState(() => _busy = false);
      if (mounted && !_closing) unawaited(_refresh());
    }
  }

  Future<void> _create() => _run(() async {
    final id = await widget.repository.createMcp(
      name: _name.text.trim(),
      endpoint: _endpoint.text.trim(),
      auth: _auth,
      clientIdRequired: _clientRequired,
    );
    if (mounted) setState(() => _id = id);
  });

  Future<void> _authorize() => _run(() async {
    final result = await widget.repository.authorize(
      _discovery!,
      clientId: _clientId.text.trim(),
    );
    _accept(result);
  });

  void _accept(NodConnectionAttempt result) {
    if (!mounted) {
      if (result.url != null) unawaited(widget.repository.cancel(result.url!));
      return;
    }
    setState(() {
      _url = result.url;
      _connected = result.url == null && result.discoveryId == null;
      _timedOut = false;
      _deadline = DateTime.now().add(const Duration(minutes: 15));
    });
  }

  Future<void> _instanceConnect() => _run(() async {
    final result = await widget.repository.instance(
      _id!,
      _instance.text.trim(),
      _token.text.trim(),
    );
    _accept(result);
  });

  Future<void> _complete() => _run(() async {
    final Object token = _settings.length > 1
        ? {
            for (final entry in _settings.entries)
              entry.key: entry.value.text.trim(),
          }
        : _settings.length == 1
        ? _settings.values.first.text.trim()
        : _token.text.trim();
    await widget.repository.complete(_id!, _account.text.trim(), token);
    if (mounted) setState(() => _connected = true);
  });

  Future<void> _open() async {
    final url = _url;
    if (url == null || _busy || _timedOut) return;
    try {
      final checked = widget.repository.launchAddress(
        url,
        instance: _instance.text.isEmpty ? null : _instance.text.trim(),
      );
      if (!await launchUrl(checked, mode: LaunchMode.externalApplication)) {
        throw StateError('Browser unavailable');
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not open this sign-in address safely. Check your server configuration.',
        );
      }
    }
  }

  Future<void> _close() async {
    if (_busy || _closing) return;
    setState(() => _closing = true);
    _timer?.cancel();
    try {
      if (_url != null && !_connected) await widget.repository.cancel(_url!);
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) {
        setState(() {
          _closing = false;
          _error = 'Cancellation was not confirmed. Try Cancel again.';
        });
      }
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    for (final controller in [
      _name,
      _endpoint,
      _account,
      _token,
      _clientId,
      _instance,
      ..._settings.values,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    bool secret = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextField(
      controller: controller,
      enabled: !_busy && !_closing,
      obscureText: secret,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: const [],
      decoration: InputDecoration(labelText: label),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final discovery = _discovery;
    final oauth = discovery?.paths.firstOrNull?['auth'] == 'oauth';
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) unawaited(_close());
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.name),
          leading: IconButton(
            icon: const Icon(Icons.close),
            onPressed: _busy || _closing ? null : _close,
          ),
        ),
        body: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Text(
              'Private setup. Credentials go only to your paired Nod server, never to chat.',
            ),
            if (_busy || _closing) const LinearProgressIndicator(),
            if (_error != null)
              Semantics(liveRegion: true, child: Text(_error!)),
            if (_connected) ...[
              const Text('Account connected.'),
              FilledButton(onPressed: _close, child: const Text('Done')),
            ] else if (!_unavailable) ...[
              if (_id == null && _url == null) ...[
                _field('Name', _name),
                _field('Public HTTPS server URL', _endpoint),
                DropdownButtonFormField<String>(
                  initialValue: _auth,
                  decoration: const InputDecoration(
                    labelText: 'Authentication',
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'oauth',
                      child: Text('Browser sign-in'),
                    ),
                    DropdownMenuItem(
                      value: 'bearer',
                      child: Text('Access token'),
                    ),
                    DropdownMenuItem(
                      value: 'x-api-key',
                      child: Text('API key'),
                    ),
                  ],
                  onChanged: _busy
                      ? null
                      : (value) => setState(() => _auth = value!),
                ),
                if (_auth == 'oauth')
                  CheckboxListTile(
                    title: const Text('Server requires a client ID'),
                    value: _clientRequired,
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _clientRequired = value!),
                  ),
                FilledButton(
                  onPressed: _busy ? null : _create,
                  child: const Text('Continue'),
                ),
              ],
              if (discovery != null) ...[
                if (discovery.setupText != null) Text(discovery.setupText!),
                if (discovery.setupUrl != null)
                  SelectableText('Setup instructions: ${discovery.setupUrl}'),
                for (final path in discovery.paths) ...[
                  Text(
                    '${path['kind']}: ${path['endpoint'] ?? path['command'] ?? ''}',
                  ),
                  Text('Authentication: ${path['auth']}'),
                  if (path['testPath'] != null)
                    Text('Read check: GET ${path['testPath']}'),
                  if (path['source'] != null)
                    Text('Install source: ${path['source']}'),
                ],
                if (discovery.needsAddress) ...[
                  _field(
                    'n8n instance address (as reached by Nod’s server)',
                    _instance,
                  ),
                  _field(
                    'Access token (optional, instead of browser sign-in)',
                    _token,
                    secret: true,
                  ),
                  FilledButton(
                    onPressed: _busy ? null : _instanceConnect,
                    child: const Text('Connect n8n'),
                  ),
                ] else if (oauth) ...[
                  if (discovery.callbackUrl != null)
                    SelectableText('Callback URL: ${discovery.callbackUrl}'),
                  if (discovery.paths.any((p) => p['clientIdRequired'] == true))
                    _field('Client ID', _clientId),
                  FilledButton(
                    onPressed: _busy ? null : _authorize,
                    child: Text(
                      _url == null ? 'Prepare sign-in' : 'Start again',
                    ),
                  ),
                ] else ...[
                  _field('Account name', _account),
                  if (_settings.isEmpty)
                    _field('Access token or API key', _token, secret: true),
                  for (final setting in _settings.entries)
                    _field(setting.key, setting.value, secret: true),
                  FilledButton(
                    onPressed: _busy ? null : _complete,
                    child: const Text('Save connection'),
                  ),
                ],
              ],
              if (_url != null && !_timedOut) ...[
                const Text(
                  'Open sign-in, review the permissions, then return here. The server checks completion.',
                ),
                OutlinedButton(
                  onPressed: _busy ? null : _open,
                  child: const Text('Open sign-in'),
                ),
              ],
              if (_id != null || _url != null)
                TextButton(
                  onPressed: _busy ? null : _refresh,
                  child: const Text('Refresh status'),
                ),
            ],
            if (!_connected)
              TextButton(
                onPressed: _busy || _closing ? null : _close,
                child: const Text('Cancel'),
              ),
          ],
        ),
      ),
    );
  }
}
