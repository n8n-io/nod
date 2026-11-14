import 'dart:async';

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/connections_management_repository.dart';
import '../../core/connections_management.dart';

class NodLinkedWhatsAppSetup extends StatefulWidget {
  const NodLinkedWhatsAppSetup({
    required this.repository,
    required this.setup,
    required this.onChanged,
    required this.onCloud,
    super.key,
  });

  final NodConnectionsManagementRepository repository;
  final NodChannelSetup? setup;
  final Future<void> Function() onChanged;
  final VoidCallback onCloud;

  @override
  State<NodLinkedWhatsAppSetup> createState() => _NodLinkedWhatsAppSetupState();
}

class _NodLinkedWhatsAppSetupState extends State<NodLinkedWhatsAppSetup>
    with WidgetsBindingObserver {
  static const _path = '/api/channel-settings/whatsapp/pairing';
  final _number = TextEditingController();
  String _mode = 'bot';
  String _state = 'connecting';
  String? _pairingId;
  String? _qr;
  String? _account;
  String? _error;
  DateTime? _expires;
  Timer? _poll;
  Timer? _expiry;
  bool _saved = false;
  bool _policy = false;
  bool _busy = false;
  bool _reading = false;
  bool _active = true;
  bool _closing = false;
  int _revision = 0;
  bool get _managed => widget.setup?.managed == true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _saved = widget.setup?.enabled == true && widget.setup?.mode == 'linked';
    _mode = widget.setup?.values['linkMode'] as String? ?? 'bot';
    _state = widget.setup?.values['connectionState'] as String? ?? 'connecting';
    if (_saved) unawaited(_read());
  }

  Future<Map<String, Object?>> _request(String method, {String? id}) async =>
      Map<String, Object?>.from(
        await widget.repository.transport.requestJson(
          method,
          _path,
          body: id == null ? null : {'pairingId': id},
        ) as Map,
      );

  void _hideQr() {
    _expiry?.cancel();
    _qr = null;
    _expires = null;
  }

  Future<void> _cancel(String? id, String state) async {
    if (_managed || id == null || state == 'connected') return;
    await _request('DELETE', id: id);
  }

  void _accept(Map<String, Object?> result) {
    final id = result['pairingId'] as String?;
    if (id != null &&
        !RegExp(r'^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')
            .hasMatch(id)) {
      throw const FormatException('Invalid pairing identity');
    }
    final state = result['state'] as String;
    if (!{
      'connecting',
      'awaiting_scan',
      'connected',
      'disconnected',
      'logged_out',
      'expired',
      'failed',
    }.contains(state)) {
      throw const FormatException('Invalid pairing state');
    }
    _hideQr();
    _pairingId = id;
    _state = state;
    _account =
        result['accountName'] as String? ?? result['accountHandle'] as String?;
    final expires = DateTime.tryParse(result['expiresAt'] as String? ?? '');
    final raw = result['qr'] as String?;
    if (_active &&
        state == 'awaiting_scan' &&
        id != null &&
        raw != null &&
        raw.isNotEmpty &&
        raw.length <= 4096 &&
        expires != null &&
        expires.isAfter(DateTime.now())) {
      try {
        if (QrValidator.validate(
              data: raw,
              version: QrVersions.auto,
              errorCorrectionLevel: QrErrorCorrectLevel.M,
            ).status ==
            QrValidationStatus.valid) {
          _qr = raw;
          _expires = expires;
          _expiry = Timer(expires.difference(DateTime.now()), () {
            if (mounted) setState(_hideQr);
          });
        }
      } catch (_) {
        _hideQr();
      }
    }
  }

  void _schedule() {
    _poll?.cancel();
    if (mounted && _active && _saved && !_busy && !_closing) {
      _poll = Timer(const Duration(seconds: 2), () => unawaited(_read()));
    }
  }

  Future<void> _read() async {
    _poll?.cancel();
    if (!mounted || !_active || !_saved || _busy || _closing) return;
    if (_reading) return;
    _reading = true;
    final version = _revision;
    try {
      final result = await _request('GET');
      if (!mounted) {
        if (!_closing && _pairingId == null) {
          await _cancel(
            result['pairingId'] as String?,
            result['state'] as String? ?? 'connecting',
          );
        }
        return;
      }
      if (version != _revision || _busy || _closing || !_active) return;
      final wasConnected = _state == 'connected';
      setState(() {
        _accept(result);
        _error = null;
      });
      if (!wasConnected && _state == 'connected') await widget.onChanged();
    } catch (_) {
      if (mounted && version == _revision && !_closing) {
        setState(() {
          _hideQr();
          _error =
              'Could not check WhatsApp. Refresh before scanning a new code.';
        });
      }
    } finally {
      _reading = false;
      _schedule();
    }
  }

  Future<void> _start({bool restart = false}) async {
    if (_busy || _closing || (_managed && !restart)) return;
    if (!restart &&
        (!_policy ||
            (_mode == 'bot' &&
                !RegExp(r'^\d{7,15}$').hasMatch(_number.text.trim())))) {
      setState(
        () => _error = 'Enter your personal number with country code, digits only, and accept the policy.',
      );
      return;
    }
    final id = _pairingId;
    if (restart && id == null) return;
    _revision++;
    _poll?.cancel();
    setState(() {
      _busy = true;
      _hideQr();
      _error = null;
    });
    try {
      Map<String, Object?> result;
      if (restart) {
        result = await _request('POST', id: id);
      } else {
        final saved = await widget.repository.saveChannel('whatsapp', {
          'mode': _mode,
          if (_mode == 'bot') 'allowedNumber': _number.text.trim(),
          'policyConfirmed': true,
        });
        if (saved['ok'] != true) {
          throw const FormatException('Setup not confirmed');
        }
        _saved = true;
        result = await _request('GET');
      }
      if (!mounted) {
        await _cancel(
          result['pairingId'] as String?,
          result['state'] as String? ?? 'connecting',
        );
        return;
      }
      setState(() => _accept(result));
      await widget.onChanged();
    } catch (_) {
      if (mounted) {
        setState(() {
          _hideQr();
          _error = 'Setup was not confirmed. Refresh before trying again.';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      _schedule();
    }
  }

  Future<void> _leave({bool cloud = false}) async {
    if (_busy || _closing) return;
    _revision++;
    _poll?.cancel();
    setState(() {
      _closing = true;
      _hideQr();
    });
    try {
      if (_saved && _pairingId == null && !_managed && _state != 'connected') {
        final result = await _request('GET');
        _pairingId = result['pairingId'] as String?;
        _state = result['state'] as String;
        if (_pairingId == null && _state != 'connected') {
          throw const FormatException('Pairing identity unavailable');
        }
      }
      await _cancel(_pairingId, _state);
      if (!mounted) return;
      if (cloud) {
        if (_state != 'connected') _saved = false;
        await widget.onChanged();
        widget.onCloud();
      } else {
        Navigator.of(context).pop();
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _closing = false;
          _error = 'Cancellation was not confirmed. Try closing again.';
        });
      }
    }
  }

  Future<void> _disconnect() async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Disconnect WhatsApp?'),
        content: const Text(
          'Nod will remove this linked device and stop receiving and sending WhatsApp messages. Your conversation stays in Nod.',
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
    if (approved != true || !mounted || _busy || _closing) return;
    _revision++;
    _poll?.cancel();
    setState(() {
      _busy = true;
      _hideQr();
      _error = null;
    });
    try {
      await widget.repository.removeChannel('whatsapp');
      if (!mounted) return;
      setState(() {
        _saved = false;
        _pairingId = null;
        _policy = false;
      });
      await widget.onChanged();
    } catch (_) {
      if (mounted) {
        setState(
          () =>
              _error = 'Disconnect was not confirmed. Refresh before retrying.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      _schedule();
    }
  }

  Future<void> _terms() async {
    try {
      await launchUrl(
        Uri.parse('https://www.whatsapp.com/legal/terms-of-service'),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not open the terms. Read them on whatsapp.com before continuing.',
        );
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    _revision++;
    _poll?.cancel();
    if (mounted) setState(_hideQr);
    if (_active) unawaited(_read());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _expiry?.cancel();
    _qr = null;
    _number.dispose();
    if (!_closing && !_busy) {
      unawaited(_cancel(_pairingId, _state).catchError((Object _) {}));
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final canRestart = {'failed', 'expired', 'logged_out'}.contains(_state);
    final busy = _busy || _closing;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) unawaited(_leave());
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (busy) const LinearProgressIndicator(),
          if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
          if (_managed)
            const Text(
              'Managed by the server. You can scan or renew this pairing, but change or remove its configuration on the server.',
            ),
          if (!_saved && !_managed) ...[
            DropdownButtonFormField<String>(
              initialValue: _mode,
              decoration: const InputDecoration(
                labelText: 'How you will message Nod',
              ),
              items: const [
                DropdownMenuItem(
                  value: 'bot',
                  child: Text('Separate bot number'),
                ),
                DropdownMenuItem(
                  value: 'self-chat',
                  child: Text('Use my own number'),
                ),
              ],
              onChanged: busy
                  ? null
                  : (value) => setState(() => _mode = value!),
            ),
            if (_mode == 'bot') ...[
              const Text(
                'Register a second number in WhatsApp or WhatsApp Business. Link that account, then message it from your personal number.',
              ),
              TextField(
                controller: _number,
                enabled: !busy,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                  labelText: 'Your personal number (country code, digits only)',
                ),
              ),
            ] else
              const Text(
                'Use Message yourself to chat with Nod. Your other chats stay outside Nod.',
              ),
            const Text(
              'WhatsApp does not officially support this connection. There is a risk of account restrictions. Nod only messages you; a separate bot number keeps your own chats separate.',
            ),
            TextButton(
              onPressed: busy ? null : _terms,
              child: const Text('Read WhatsApp terms'),
            ),
            CheckboxListTile(
              value: _policy,
              onChanged: busy
                  ? null
                  : (value) => setState(() => _policy = value!),
              title: const Text(
                'I understand the account risk and have checked the WhatsApp terms.',
              ),
            ),
            FilledButton(
              onPressed: busy || !_policy ? null : _start,
              child: const Text('Show QR code'),
            ),
          ],
          if (_saved) ...[
            Semantics(
              liveRegion: true,
              child: Text(switch (_state) {
                'connected' =>
                  '${_account ?? 'Your WhatsApp account'} connected',
                'awaiting_scan' => 'In WhatsApp, open Settings → Linked Devices → Link a Device, then scan this code from another screen.',
                'expired' =>
                  'The QR setup expired. Start again to get a new code.',
                'logged_out' =>
                  'WhatsApp signed out this device. Link it again.',
                'failed' => 'WhatsApp could not connect. Check the connection and start again.',
                'disconnected' =>
                  'WhatsApp is disconnected. Nod is trying to reconnect.',
                _ => 'Connecting to WhatsApp…',
              }),
            ),
            if (_active &&
                _state == 'awaiting_scan' &&
                _qr != null &&
                _expires?.isAfter(DateTime.now()) == true)
              Center(
                child: QrImageView(
                  data: _qr!,
                  size: 240,
                  padding: const EdgeInsets.all(16),
                  backgroundColor: Colors.white,
                  eyeStyle: const QrEyeStyle(
                    eyeShape: QrEyeShape.square,
                    color: Colors.black,
                  ),
                  dataModuleStyle: const QrDataModuleStyle(
                    dataModuleShape: QrDataModuleShape.square,
                    color: Colors.black,
                  ),
                  errorCorrectionLevel: QrErrorCorrectLevel.M,
                  semanticsLabel: 'Link WhatsApp to Nod',
                ),
              ),
            if (_state == 'awaiting_scan' && _qr == null)
              const Text('Waiting for a new QR code. Refresh to check again.'),
            if (_state != 'connected' && !_managed)
              const Text(
                'Closing this panel cancels unfinished setup. Codes expire automatically; the setup lasts five minutes.',
              ),
            if (_state == 'connected')
              Text(
                _mode == 'self-chat'
                    ? 'Open WhatsApp and use Message yourself.'
                    : 'Message the linked account from your personal WhatsApp number.',
              ),
            if (canRestart)
              FilledButton(
                onPressed: busy || _pairingId == null
                    ? null
                    : () => _start(restart: true),
                child: const Text('Start again'),
              ),
            if (!_managed)
              TextButton(
                onPressed: busy ? null : _disconnect,
                child: const Text('Disconnect'),
              ),
            TextButton(
              onPressed: busy ? null : _read,
              child: const Text('Refresh WhatsApp status'),
            ),
          ],
          if (!_managed && !_saved)
            TextButton(
              onPressed: busy ? null : () => _leave(cloud: true),
              child: const Text('Use Meta Cloud API instead'),
            ),
          TextButton(
            onPressed: busy ? null : _leave,
            child: Text(
              _state == 'connected' && _saved ? 'Done' : 'Cancel setup',
            ),
          ),
        ],
      ),
    );
  }
}
