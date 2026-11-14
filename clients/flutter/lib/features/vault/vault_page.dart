import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../api/vault_repository.dart';
import '../../core/api_transport.dart';
import '../../core/vault.dart';
import '../private_requests/private_requests_page.dart';
import 'vault_form.dart';
import 'vault_import.dart';

class NodVaultPage extends StatefulWidget {
  const NodVaultPage({super.key, required this.transport, this.onAsk});
  final NodApiTransport transport;
  final Future<void> Function(String text)? onAsk;

  @override
  State<NodVaultPage> createState() => _NodVaultPageState();
}

class _NodVaultPageState extends State<NodVaultPage> {
  late final _repository = NodVaultRepository(widget.transport);
  List<NodVaultItem>? _items;
  String? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final generation = ++_generation;
    try {
      final entries = await _repository.list();
      final sessions = await _repository.sessions();
      if (!mounted || generation != _generation) return;
      setState(() {
        _items = [...entries, ...sessions];
        _error = null;
      });
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(() => _error = 'Vault could not be refreshed.');
      }
    }
  }

  Future<void> _open(Widget page) async {
    await Navigator.of(context)
        .push<void>(MaterialPageRoute(builder: (_) => page));
    if (mounted) await _refresh();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Vault'),
      actions: [
        IconButton(
          onPressed: _refresh,
          icon: const Icon(Icons.refresh),
          tooltip: 'Refresh Vault',
        ),
        PopupMenuButton<String>(
          tooltip: 'Add to Vault',
          onSelected: (kind) => _open(
            kind == 'import'
                ? NodVaultImportPage(repository: _repository)
                : NodVaultForm(repository: _repository, kind: kind),
          ),
          itemBuilder: (_) => const [
            PopupMenuItem(value: 'login', child: Text('Add login')),
            PopupMenuItem(value: 'card', child: Text('Add card')),
            PopupMenuItem(value: 'import', child: Text('Import passwords')),
          ],
        ),
      ],
    ),
    body: RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Manage saved logins, cards, and browser sessions. Secrets go directly to your Nod server, never through chat.',
          ),
          TextButton(
            onPressed: () =>
                _open(NodPrivateRequestsPage(transport: widget.transport)),
            child: const Text('Open private requests'),
          ),
          if (_error != null) Text(_error!),
          if (_items == null && _error == null)
            const Center(child: CircularProgressIndicator()),
          if (_items?.isEmpty == true)
            const ListTile(
              title: Text('No saved items'),
              subtitle: Text(
                'Add a login or card, or import a password-manager CSV.',
              ),
            ),
          for (final item in _items ?? <NodVaultItem>[])
            ListTile(
              leading: Icon(
                item.session
                    ? Icons.language
                    : item.card
                    ? Icons.credit_card
                    : Icons.key,
              ),
              title: Text(item.label),
              subtitle: Text(
                '${item.subtitle}${item.session
                    ? '\n${item.sessionState}'
                    : item.unreadable
                    ? '\nCannot be opened with the current Vault key'
                    : ''}',
              ),
              isThreeLine: item.session || item.unreadable,
              onTap: () => _open(
                NodVaultDetails(
                  repository: _repository,
                  item: item,
                  onAsk: widget.onAsk,
                ),
              ),
            ),
          const Divider(),
          NodVaultActivityView(
            repository: _repository,
            key: ValueKey(_generation),
          ),
        ],
      ),
    ),
  );
}

class NodVaultDetails extends StatefulWidget {
  const NodVaultDetails({
    super.key,
    required this.repository,
    required this.item,
    this.onAsk,
  });
  final NodVaultRepository repository;
  final NodVaultItem item;
  final Future<void> Function(String text)? onAsk;

  @override
  State<NodVaultDetails> createState() => _NodVaultDetailsState();
}

class _NodVaultDetailsState extends State<NodVaultDetails>
    with WidgetsBindingObserver {
  NodVaultItem? _details;
  String? _secret;
  String? _error;
  String? _notice;
  bool _busy = false;
  bool _active = true;
  bool _signInRequested = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (!_active) {
      _generation++;
      setState(() {
        _secret = null;
        _notice = null;
        _busy = false;
      });
    } else {
      _load();
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    try {
      final details = widget.item.session
          ? widget.item
          : await widget.repository.details(widget.item);
      if (mounted && _active && generation == _generation) {
        setState(() {
          _details = details;
          _error = null;
        });
      }
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(
          () => _error = 'This item could not be opened. Restore the Vault key if needed, or delete the item.',
        );
      }
    }
  }

  Future<void> _reveal() async {
    if (_busy || !_active || _details == null) return;
    final generation = ++_generation;
    setState(() {
      _secret = null;
      _busy = true;
      _error = null;
    });
    try {
      final value = await widget.repository.reveal(_details!);
      if (_current(generation)) {
        setState(() => _secret = value);
      }
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(
          () => _error = 'The saved value could not be shown. Reopen the item before trying again.',
        );
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  bool _current(int generation) =>
      mounted &&
      _active &&
      generation == _generation &&
      widget.repository.isCurrent &&
      ModalRoute.of(context)?.isCurrent != false;

  Future<void> _copy({bool identity = false}) async {
    final item = _details;
    if (_busy || !_current(_generation) || item == null) return;
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
      _secret = null;
    });
    var value = '';
    try {
      value = identity
          ? await widget.repository.copyIdentity(item)
          : await widget.repository.reveal(item);
      if (!_current(generation)) return;
      final copying = Clipboard.setData(ClipboardData(text: value));
      value = '';
      await copying;
      if (_current(generation)) {
        setState(
          () => _notice = identity
              ? '${item.card ? 'Cardholder' : 'Username'} copied.'
              : '${item.card ? 'Card number' : 'Password'} copied.',
        );
      }
    } catch (_) {
      if (_current(generation)) {
        setState(
          () => _error =
              'Could not copy this value. Reopen the item before trying again.',
        );
      }
    } finally {
      value = '';
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _signInAgain() async {
    final ask = widget.onAsk;
    final item = _details;
    if (_busy || !_active || _signInRequested || ask == null || item == null) {
      return;
    }
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final text = await widget.repository.signInAgainRequest(item);
      if (!_current(generation)) return;
      _signInRequested = true;
      await ask(text);
    } catch (_) {
      if (_current(generation) && !_signInRequested) {
        setState(
          () => _error = 'This session changed or could not be checked. Refresh Vault before trying again.',
        );
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _remove() async {
    if (_busy) return;
    setState(() => _secret = null);
    final item = _details ?? widget.item;
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          item.session
              ? 'Sign out of this session?'
              : 'Delete this ${item.kind}?',
        ),
        content: Text(
          item.session
              ? 'Remove the saved browser session for ${item.origin}. Your saved login stays in Vault.'
              : 'Remove ${item.label} from Vault? This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(item.session ? 'Sign out' : 'Delete'),
          ),
        ],
      ),
    );
    if (approved != true || !mounted || !_active) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.repository.remove(item);
      if (mounted) Navigator.pop(context);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Removal was not confirmed. Refresh Vault before trying again.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _edit() async {
    final item = _details;
    if (item == null || _busy) return;
    setState(() => _secret = null);
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => NodVaultForm(
          repository: widget.repository,
          kind: item.kind,
          item: item,
        ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  void dispose() {
    _generation++;
    _secret = null;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final item = _details ?? widget.item;
    return Scaffold(
      appBar: AppBar(
        title: Text(item.label),
        actions: [
          if (!item.session)
            TextButton(
              onPressed: _details == null || _busy ? null : _edit,
              child: const Text('Edit'),
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(item.subtitle, style: Theme.of(context).textTheme.titleMedium),
          if (_details == null && _error == null)
            const LinearProgressIndicator(),
          if (_details != null && !item.session) ...[
            ListTile(
              title: Text(item.card ? 'Cardholder' : 'Username'),
              subtitle: Text(
                item.identity.isEmpty ? 'Not saved' : item.identity,
              ),
              trailing: IconButton(
                onPressed: _busy ? null : () => _copy(identity: true),
                icon: const Icon(Icons.copy),
                tooltip: item.card ? 'Copy cardholder' : 'Copy username',
              ),
            ),
            if (item.card)
              ListTile(
                title: const Text('Expiry'),
                subtitle: Text(
                  '${item.data['expiryMonth']}/${item.data['expiryYear']}',
                ),
              ),
            if (!item.card)
              ListTile(
                title: const Text('Authenticator key'),
                subtitle: Text(
                  item.data['hasAuthenticator'] == true
                      ? 'Saved on server'
                      : 'Not saved',
                ),
              ),
            ListTile(
              title: Text(item.card ? 'Card number' : 'Password'),
              subtitle: Text(
                _secret ??
                    (item.data['hasPassword'] == false
                        ? 'Not saved'
                        : '••••••••'),
              ),
              trailing: item.card || item.data['hasPassword'] != false
                  ? IconButton(
                      onPressed: _busy ? null : _copy,
                      icon: const Icon(Icons.copy),
                      tooltip: item.card ? 'Copy card number' : 'Copy password',
                    )
                  : null,
            ),
            TextButton(
              onPressed: _busy
                  ? null
                  : _secret == null
                  ? _reveal
                  : () => setState(() => _secret = null),
              child: Text(
                _secret == null
                    ? 'Show saved value privately'
                    : 'Hide saved value',
              ),
            ),
          ],
          if (item.session)
            ListTile(
              title: const Text('Saved session'),
              subtitle: Text(item.sessionState),
            ),
          if (item.session &&
              widget.onAsk != null &&
              ['needs_sign_in', 'pending'].contains(item.data['state']))
            OutlinedButton(
              onPressed: _busy || _signInRequested ? null : _signInAgain,
              child: const Text('Sign in again'),
            ),
          if (_error != null) Text(_error!),
          if (_notice != null)
            Semantics(liveRegion: true, child: Text(_notice!)),
          FilledButton.tonal(
            onPressed: _busy ? null : _remove,
            child: Text(item.session ? 'Sign out' : 'Delete ${item.kind}'),
          ),
          const Divider(),
          NodVaultActivityView(repository: widget.repository, item: item),
        ],
      ),
    );
  }
}

class NodVaultActivityView extends StatefulWidget {
  const NodVaultActivityView({super.key, required this.repository, this.item});
  final NodVaultRepository repository;
  final NodVaultItem? item;

  @override
  State<NodVaultActivityView> createState() => _NodVaultActivityViewState();
}

class _NodVaultActivityViewState extends State<NodVaultActivityView> {
  final _entries = <Map<String, Object?>>[];
  NodVaultActivity? _activity;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final activity = await widget.repository.activity(
        item: widget.item,
        next: _activity?.next,
      );
      if (mounted) {
        setState(() {
          _activity = activity;
          _entries.addAll(activity.entries);
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Activity could not be loaded.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('Activity', style: Theme.of(context).textTheme.titleMedium),
      if (widget.item == null && _activity != null)
        Text(
          'This week: ${_activity!.week['signIns']} sign-ins · ${_activity!.week['payments']} card submissions · ${_activity!.week['held']} held',
        ),
      for (final entry in _entries)
        ListTile(
          title: Text(
            '${entry['action'].toString().replaceAll('_', ' ')} · ${entry['origin']}',
          ),
          subtitle: Text(
            [
              '${entry['at']}',
              if (entry['task'] != '') '${entry['task']}',
              entry['reason'].toString().replaceAll('_', ' '),
              if (entry['amount'] is Map)
                '${(entry['amount'] as Map)['minor']} minor units ${(entry['amount'] as Map)['currency']}',
              if (entry['because'] is Map &&
                  (entry['because'] as Map)['text'] is String)
                '“${(entry['because'] as Map)['text']}”',
            ].join('\n'),
          ),
        ),
      if (_entries.isEmpty && !_busy && _error == null)
        const Text('No activity yet.'),
      if (_error != null) Text(_error!),
      if (_busy) const LinearProgressIndicator(),
      if (!_busy && (_error != null || _activity?.next != null))
        TextButton(
          onPressed: _load,
          child: Text(_error == null ? 'Load more activity' : 'Try again'),
        ),
    ],
  );
}
