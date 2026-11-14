import 'package:flutter/material.dart';

import '../../api/vault_repository.dart';
import '../../core/vault.dart';

class NodVaultForm extends StatefulWidget {
  const NodVaultForm({
    super.key,
    required this.repository,
    required this.kind,
    this.item,
  });
  final NodVaultRepository repository;
  final String kind;
  final NodVaultItem? item;

  @override
  State<NodVaultForm> createState() => _NodVaultFormState();
}

class _NodVaultFormState extends State<NodVaultForm>
    with WidgetsBindingObserver {
  final _form = GlobalKey<FormState>();
  final _fields = <String, TextEditingController>{};
  bool _busy = false;
  bool _active = true;
  bool _removeAuthenticator = false;
  String? _error;
  bool get _card => widget.kind == 'card';
  bool get _editing => widget.item != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final item = widget.item;
    for (final key in [
      'label',
      'origin',
      'username',
      'cardholder',
      'password',
      'authenticatorKey',
      'cardNumber',
      'expiryMonth',
      'expiryYear',
    ]) {
      _fields[key] = TextEditingController(
        text: item?.data[key]?.toString() ?? '',
      );
    }
  }

  void _clearSecrets() {
    for (final key in ['password', 'authenticatorKey', 'cardNumber']) {
      _fields[key]!.clear();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (!_active) _clearSecrets();
  }

  Future<void> _save() async {
    if (_busy || !_active || !_form.currentState!.validate()) return;
    final values = <String, Object?>{
      'kind': widget.kind,
      'label': _fields['label']!.text.trim(),
      if (!_card) 'username': _fields['username']!.text,
      if (!_card && !_editing) 'origin': _fields['origin']!.text.trim(),
      if (!_card && (!_editing || _fields['password']!.text.isNotEmpty))
        'password': _fields['password']!.text,
      if (!_card && _fields['authenticatorKey']!.text.trim().isNotEmpty)
        'authenticatorKey': _fields['authenticatorKey']!.text.trim(),
      if (!_card && _removeAuthenticator) 'authenticatorKey': '',
      if (_card) 'cardholder': _fields['cardholder']!.text.trim(),
      if (_card) 'expiryMonth': int.parse(_fields['expiryMonth']!.text),
      if (_card) 'expiryYear': int.parse(_fields['expiryYear']!.text),
      if (_card && (!_editing || _fields['cardNumber']!.text.isNotEmpty))
        'cardNumber': _fields['cardNumber']!.text,
    };
    _clearSecrets();
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.repository.save(values, item: widget.item);
      if (mounted) Navigator.pop(context);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Save was not confirmed. Check the fields and refresh Vault before trying again. Private values have been cleared.',
        );
      }
    } finally {
      values.clear();
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _field(
    String name,
    String label, {
    bool secret = false,
    bool required = false,
    bool numeric = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextFormField(
      controller: _fields[name],
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      enabled: !_busy,
      obscureText: secret,
      autocorrect: false,
      enableSuggestions: false,
      enableIMEPersonalizedLearning: !secret,
      keyboardType: numeric
          ? TextInputType.number
          : secret
          ? TextInputType.visiblePassword
          : TextInputType.text,
      validator: (value) {
        if (required && (value == null || value.trim().isEmpty)) {
          return 'Enter a value.';
        }
        if (numeric) {
          final number = int.tryParse(value ?? '');
          if (number == null ||
              (name == 'expiryMonth'
                  ? number < 1 || number > 12
                  : number < 2000 || number > 9999)) {
            return 'Enter a valid ${name == 'expiryMonth' ? 'month' : 'year'}.';
          }
        }
        return null;
      },
    ),
  );

  @override
  void dispose() {
    _clearSecrets();
    for (final controller in _fields.values) {
      controller.dispose();
    }
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('${_editing ? 'Edit' : 'Add'} ${widget.kind}')),
    body: Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Private Vault entry. Values go directly to your Nod server, never to chat. Closing or leaving the app clears unsent secret fields.',
          ),
          _field('label', 'Name', required: true),
          if (!_card && !_editing)
            _field('origin', 'Website domain or HTTPS URL', required: true),
          if (!_card && _editing)
            ListTile(
              title: const Text('Website'),
              subtitle: Text(widget.item!.origin),
            ),
          if (_card) ...[
            _field('cardholder', 'Cardholder', required: true),
            _field(
              'cardNumber',
              _editing ? 'Replacement card number (optional)' : 'Card number',
              secret: true,
              required: !_editing,
            ),
            _field(
              'expiryMonth',
              'Expiry month',
              required: true,
              numeric: true,
            ),
            _field('expiryYear', 'Expiry year', required: true, numeric: true),
            const Text(
              'Nod never stores the security code. Payments need a separate private approval.',
            ),
          ] else ...[
            _field(
              'username',
              widget.item?.data['identifierLabel'] as String? ??
                  'Username or email',
            ),
            _field(
              'password',
              _editing ? 'Replacement password (optional)' : 'Password',
              secret: true,
            ),
            if (!_removeAuthenticator)
              _field(
                'authenticatorKey',
                _editing
                    ? 'Replacement authenticator key (optional)'
                    : 'Authenticator setup key or otpauth link (optional)',
                secret: true,
              ),
            if (_editing)
              CheckboxListTile(
                value: _removeAuthenticator,
                title: const Text('Remove saved authenticator key'),
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                        _removeAuthenticator = value!;
                        _fields['authenticatorKey']!.clear();
                      }),
              ),
            if (_editing)
              const Text(
                'Leave replacement fields blank to keep saved values.',
              ),
          ],
          if (_error != null) Text(_error!),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Text(_busy ? 'Saving' : 'Save'),
          ),
        ],
      ),
    ),
  );
}
