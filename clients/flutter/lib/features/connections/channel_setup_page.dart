import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/connections_management_repository.dart';
import '../../core/connections_management.dart';
import 'linked_whatsapp_setup.dart';

class NodChannelSetupPage extends StatefulWidget {
  const NodChannelSetupPage({
    required this.repository,
    required this.provider,
    super.key,
  });

  final NodConnectionsManagementRepository repository;
  final String provider;

  @override
  State<NodChannelSetupPage> createState() => _NodChannelSetupPageState();
}

class _NodChannelSetupPageState extends State<NodChannelSetupPage>
    with WidgetsBindingObserver {
  final _fields = <String, TextEditingController>{};
  NodChannelSetup? _setup;
  Uri? _pairing;
  String? _error;
  bool _busy = false;
  bool _loading = false;
  bool _active = true;
  bool _policy = false;
  bool _editing = false;
  bool _loaded = false;
  bool _cloud = false;
  bool _linkedRequested = false;
  Timer? _timer;
  bool get _telegram => widget.provider == 'telegram';
  TextEditingController _controller(String name) =>
      _fields.putIfAbsent(name, TextEditingController.new);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (_active) {
      unawaited(_load());
    } else {
      _timer?.cancel();
    }
  }

  Future<void> _load() async {
    _timer?.cancel();
    if (!mounted || _loading || _busy || !_active) return;
    _loading = true;
    try {
      final channels = await widget.repository.channels();
      if (mounted) {
        setState(() {
          _setup = channels
              .where((c) => c.provider == widget.provider)
              .firstOrNull;
          _loaded = true;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not refresh channel status. Try again.');
      }
    } finally {
      _loading = false;
      if (mounted &&
          _active &&
          _telegram &&
          _setup?.enabled == true &&
          _setup?.values['allowedUserId'] == null) {
        _timer = Timer(const Duration(seconds: 3), () => unawaited(_load()));
      }
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy || _loading) return;
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
          () => _error = 'Channel change was not confirmed. Check the details and refresh before retrying.',
        );
      }
    } finally {
      if (mounted) {
        for (final key in [
          'botToken',
          'accessToken',
          'appSecret',
          'verifyToken',
        ]) {
          _fields[key]?.clear();
        }
      }
      if (mounted) setState(() => _busy = false);
      if (mounted) await _load();
    }
  }

  void _result(Map<String, Object?> result) {
    if (!mounted) return;
    setState(() {
      final raw = result['pairingUrl'] as String?;
      _pairing = raw == null ? null : Uri.parse(raw);
      _editing = false;
    });
  }

  Future<void> _save() => _run(() async {
    final body = <String, Object?>{
      for (final key
          in _telegram
              ? ['botToken']
              : [
                  'accessToken',
                  'appSecret',
                  'phoneNumberId',
                  'allowedNumber',
                  'verifyToken',
                ])
        key: _controller(key).text.trim(),
      if (_controller('webhookUrl').text.trim().isNotEmpty)
        'webhookUrl': _controller('webhookUrl').text.trim(),
      if (!_telegram) 'policyConfirmed': true,
    };
    _result(await widget.repository.saveChannel(widget.provider, body));
  });

  Future<void> _pair(String action) => _run(() async {
    _result(
      await widget.repository.telegram(
        action,
        userId: action == 'user'
            ? _controller('allowedUserId').text.trim()
            : null,
      ),
    );
  });

  Future<void> _disconnect() async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Disconnect channel?'),
        content: const Text(
          'Nod will stop receiving and sending messages through this channel. Your conversation stays in Nod.',
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
    if (approved == true && mounted) {
      await _run(() async {
        await widget.repository.removeChannel(widget.provider);
        if (mounted) {
          setState(() {
            _pairing = null;
            _editing = false;
          });
        }
      });
    }
  }

  Future<void> _openPairing() async {
    final url = _pairing;
    if (url == null ||
        url.scheme != 'https' ||
        url.host != 't.me' ||
        url.userInfo.isNotEmpty) {
      return;
    }
    try {
      if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
        throw StateError('Unavailable');
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not open Telegram. Start pairing again when ready.',
        );
      }
    }
  }

  Widget _field(String key, String label, {bool secret = false}) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextField(
      controller: _controller(key),
      enabled: !_busy,
      obscureText: secret,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: const [],
      decoration: InputDecoration(labelText: label),
    ),
  );

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    for (final field in _fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final setup = _setup;
    final values = setup?.values ?? {};
    final candidate = values['pairingCandidate'] as Map?;
    final expires = DateTime.tryParse(
      values['pairingExpiresAt'] as String? ?? '',
    );
    final pairingActive = expires != null && expires.isAfter(DateTime.now());
    final managed = setup?.managed == true;
    if (!_telegram && !_loaded) {
      return Scaffold(
        appBar: AppBar(title: const Text('WhatsApp')),
        body: Center(
          child: _error == null
              ? const CircularProgressIndicator()
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(_error!),
                    TextButton(
                      onPressed: _load,
                      child: const Text('Refresh status'),
                    ),
                  ],
                ),
        ),
      );
    }
    if (!_telegram &&
        !_cloud &&
        (_linkedRequested ||
            setup?.enabled != true ||
            setup?.mode == 'linked')) {
      return Scaffold(
        appBar: AppBar(title: const Text('WhatsApp')),
        body: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            NodLinkedWhatsAppSetup(
              repository: widget.repository,
              setup: setup,
              onChanged: _load,
              onCloud: () => setState(() {
                _cloud = true;
                _editing = true;
                _linkedRequested = false;
              }),
            ),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(_telegram ? 'Telegram' : 'WhatsApp')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text(
            'Configure privately on your paired Nod server. Never paste these credentials into chat.',
          ),
          if (_busy) const LinearProgressIndicator(),
          if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
          if (setup?.enabled == true) ...[
            Text(
              '${values['accountName'] ?? values['accountHandle'] ?? widget.provider} · ${values['connectionState'] ?? values['mode'] ?? 'Enabled'}',
            ),
            if (values['webhookStatus'] != null)
              Text('Webhook: ${values['webhookStatus']}'),
            if (values['webhookUrl'] != null)
              SelectableText('Callback URL: ${values['webhookUrl']}'),
            if (values['pairedUser'] != null)
              Text('Paired with ${values['pairedUser']}'),
            if (values['allowedUserId'] != null)
              Text('Allowed user: ${values['allowedUserId']}'),
          ],
          if (managed)
            const Text(
              'Managed by the server environment. Change or remove its configuration there.',
            ),
          if (!managed && (_editing || setup?.enabled != true)) ...[
            if (_telegram) ...[
              _field('botToken', 'BotFather bot token', secret: true),
              const Text(
                'Default delivery uses polling. A bot already using a webhook must be reconfigured first.',
              ),
            ] else ...[
              const Text(
                'Meta Cloud API setup requires a business sender and public HTTPS callback. Replies are limited to 24 hours after your last message.',
              ),
              _field('phoneNumberId', 'Business phone number ID'),
              _field(
                'allowedNumber',
                'Your personal number (country code, digits only)',
              ),
              _field('accessToken', 'Business access token', secret: true),
              _field('appSecret', 'Meta app secret', secret: true),
              _field('verifyToken', 'Webhook verification token', secret: true),
              CheckboxListTile(
                value: _policy,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _policy = value!),
                title: const Text(
                  'I understand the account risk and agree to WhatsApp’s terms and policies.',
                ),
              ),
            ],
            _field(
              'webhookUrl',
              'Public HTTPS webhook URL (optional if configured by server)',
            ),
            FilledButton(
              onPressed: _busy || (!_telegram && !_policy) ? null : _save,
              child: Text(_telegram ? 'Connect bot' : 'Save Cloud API setup'),
            ),
          ],
          if (!managed && setup?.enabled == true) ...[
            if (_telegram && values['allowedUserId'] == null) ...[
              const Text(
                'Pair your own Telegram account. Open the pairing link and send Start, then confirm the account shown here.',
              ),
              if (_pairing != null && pairingActive)
                OutlinedButton(
                  onPressed: _busy ? null : _openPairing,
                  child: const Text('Open Telegram pairing'),
                ),
              if (candidate != null && pairingActive) ...[
                Text(
                  'Pair with ${candidate['name']} (${candidate['id']})${candidate['username'] == null ? '' : ' @${candidate['username']}'}?',
                ),
                FilledButton(
                  onPressed: _busy ? null : () => _pair('confirm'),
                  child: const Text('Confirm my account'),
                ),
              ],
              TextButton(
                onPressed: _busy ? null : () => _pair('pairing'),
                child: const Text('Start pairing again'),
              ),
              _field(
                'allowedUserId',
                'Your Telegram user ID (alternative to pairing)',
              ),
              OutlinedButton(
                onPressed: _busy ? null : () => _pair('user'),
                child: const Text('Use this user ID'),
              ),
            ],
            TextButton(
              onPressed: _busy
                  ? null
                  : () => setState(() => _editing = !_editing),
              child: const Text('Edit configuration'),
            ),
            TextButton(
              onPressed: _busy ? null : _disconnect,
              child: const Text('Disconnect'),
            ),
          ],
          if (!_telegram && !managed)
            TextButton(
              onPressed: _busy
                  ? null
                  : () => setState(() {
                      _cloud = false;
                      _linkedRequested = true;
                      _editing = false;
                    }),
              child: const Text('Use linked-device QR instead'),
            ),
          TextButton(
            onPressed: _busy ? null : _load,
            child: const Text('Refresh status'),
          ),
        ],
      ),
    );
  }
}
