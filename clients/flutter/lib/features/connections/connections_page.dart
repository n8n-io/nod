import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/connections_management_repository.dart';
import '../../core/api_transport.dart';
import '../../core/connections_management.dart';
import 'channel_setup_page.dart';
import 'connection_setup_page.dart';

class NodConnectionsPage extends StatefulWidget {
  const NodConnectionsPage({required this.transport, super.key});

  final NodApiTransport transport;

  @override
  State<NodConnectionsPage> createState() => _NodConnectionsPageState();
}

class _NodConnectionsPageState extends State<NodConnectionsPage>
    with WidgetsBindingObserver {
  late final _repository = NodConnectionsManagementRepository(widget.transport);
  List<NodManagedConnection> _accounts = [];
  List<NodManagedConnection> _catalog = [];
  List<NodChannelSetup> _channels = [];
  bool _loading = false;
  bool _busy = false;
  String? _error;
  String _query = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load());
  }

  Future<void> _load() async {
    if (!mounted || _loading) return;
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        _repository.load(),
        _repository.load(catalog: true),
        _repository.channels(),
      ]);
      if (!mounted) return;
      setState(() {
        _accounts = results[0] as List<NodManagedConnection>;
        _catalog = results[1] as List<NodManagedConnection>;
        _channels = results[2] as List<NodChannelSetup>;
        _error = null;
      });
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not refresh connections. Try again.');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _connect(
    NodManagedConnection account, {
    bool additional = false,
  }) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final attempt = await _repository.connect(
        account,
        additional: additional,
      );
      if (!mounted) {
        if (attempt.url != null) await _repository.cancel(attempt.url!);
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => NodConnectionSetupPage(
            repository: _repository,
            name: account.name,
            initialAttempt: attempt,
          ),
        ),
      );
      await _load();
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not start sign-in. Refresh and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(NodManagedConnection account) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Disconnect ${account.name}?'),
        content: Text(
          'Remove ${account.account ?? 'this account'} from Nod. Private work linked to this connection is removed too. Other accounts stay connected. You can also revoke access in the provider’s settings.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect'),
          ),
        ],
      ),
    );
    if (approved != true || !mounted || _busy) return;
    setState(() => _busy = true);
    try {
      await _repository.disconnect(account);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Removal was not confirmed. Refresh before trying again.',
        );
      }
      return;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _load();
  }

  Future<void> _mcp() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            NodConnectionSetupPage(repository: _repository, name: 'MCP server'),
      ),
    );
    await _load();
  }

  Future<void> _channel(String provider) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            NodChannelSetupPage(repository: _repository, provider: provider),
      ),
    );
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final slugs = {
      ..._accounts.map((a) => a.slug),
      ..._catalog.map((a) => a.slug),
    }.toList()..sort();
    final disabled = _busy || _loading;
    return Scaffold(
      appBar: AppBar(title: const Text('Accounts and channels')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              'Manage connections',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const Text(
              'Accounts and private configuration stay on your Nod server.',
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 12,
              children: [
                OutlinedButton(
                  onPressed: disabled ? null : _mcp,
                  child: const Text('Connect MCP'),
                ),
                for (final provider in ['telegram', 'whatsapp'])
                  OutlinedButton(
                    onPressed: disabled ? null : () => _channel(provider),
                    child: Text(
                      provider == 'telegram' ? 'Telegram' : 'WhatsApp',
                    ),
                  ),
              ],
            ),
            for (final channel in _channels.where((channel) => channel.enabled))
              ListTile(
                title: Text(channel.provider),
                subtitle: Text(
                  '${channel.values['accountName'] ?? channel.values['accountHandle'] ?? channel.values['mode'] ?? 'Connected'}${channel.managed ? ' · Server managed' : ''}',
                ),
              ),
            TextField(
              decoration: const InputDecoration(labelText: 'Search apps'),
              onChanged: (value) =>
                  setState(() => _query = value.toLowerCase()),
            ),
            if (_loading) const LinearProgressIndicator(),
            if (_error != null) ...[
              Semantics(liveRegion: true, child: Text(_error!)),
              TextButton(onPressed: _load, child: const Text('Refresh')),
            ],
            for (final slug in slugs) ...[
              if ([..._accounts, ..._catalog]
                  .where((a) => a.slug == slug)
                  .any(
                    (a) => '${a.name} ${a.slug}'.toLowerCase().contains(_query),
                  ))
                Builder(
                  builder: (context) {
                    final accounts = _accounts
                        .where((a) => a.slug == slug && a.id != null)
                        .toList();
                    final app = [
                      ...accounts,
                      ..._catalog.where((a) => a.slug == slug),
                      ..._accounts.where((a) => a.slug == slug),
                    ].first;
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            app.name,
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          for (final account in accounts)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 8),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(account.account ?? account.name),
                                  Text(
                                    account.disconnectPending
                                        ? 'Removal pending'
                                        : account.status,
                                  ),
                                  for (final path in account.paths)
                                    Text(
                                      '${path['kind']}: ${path['endpoint'] ?? ''}',
                                    ),
                                  Wrap(
                                    spacing: 8,
                                    children: [
                                      if (account.canReconnect)
                                        OutlinedButton(
                                          onPressed:
                                              disabled ||
                                                  account.disconnectPending
                                              ? null
                                              : () => _connect(account),
                                          child: const Text('Reconnect'),
                                        ),
                                      TextButton(
                                        onPressed:
                                            disabled ||
                                                account.disconnectPending
                                            ? null
                                            : () => _remove(account),
                                        child: const Text('Disconnect'),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          OutlinedButton(
                            onPressed:
                                disabled || app.status == 'not_configured'
                                ? null
                                : () => _connect(
                                    app,
                                    additional: accounts.isNotEmpty,
                                  ),
                            child: Text(
                              accounts.isEmpty ? 'Connect' : 'Add account',
                            ),
                          ),
                          if (app.status == 'not_configured')
                            const Text(
                              'Sign-in unavailable. Check the server configuration.',
                            ),
                        ],
                      ),
                    );
                  },
                ),
            ],
          ],
        ),
      ),
    );
  }
}
