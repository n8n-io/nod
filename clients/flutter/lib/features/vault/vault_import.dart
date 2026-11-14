import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../../api/vault_repository.dart';
import '../../core/vault.dart';

class NodVaultImportPage extends StatefulWidget {
  const NodVaultImportPage({super.key, required this.repository});
  final NodVaultRepository repository;

  @override
  State<NodVaultImportPage> createState() => _NodVaultImportPageState();
}

class _NodVaultImportPageState extends State<NodVaultImportPage>
    with WidgetsBindingObserver {
  NodVaultImport? _input;
  Map<String, Object?>? _result;
  String? _error;
  bool _busy = false;
  bool _active = true;
  int _generation = 0;
  int _skipped = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  void _clear() {
    _input?.clear();
    _input = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (!_active) setState(_clear);
  }

  Future<void> _choose() async {
    final generation = ++_generation;
    setState(() {
      _clear();
      _error = null;
      _busy = true;
    });
    try {
      final selected = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: ['csv'],
      );
      if (!mounted || !_active || generation != _generation) return;
      if (selected == null) return;
      final size = await selected.length();
      if (size == null || size > 5000000) {
        throw const FormatException('Unsupported file.');
      }
      final bytes = await selected.readAsBytes();
      if (!mounted ||
          !_active ||
          generation != _generation ||
          bytes.length > 5000000) {
        bytes.fillRange(0, bytes.length, 0);
        return;
      }
      NodVaultImport? input;
      try {
        input = parseVaultCsv(utf8.decode(bytes));
      } finally {
        bytes.fillRange(0, bytes.length, 0);
      }
      if (input.logins.length > 10000) {
        input.clear();
        throw const FormatException('Too many logins.');
      }
      setState(() => _input = input);
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(
          () =>
              _error = 'Choose a valid password-manager CSV smaller than 5 MB.',
        );
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    final input = _input;
    if (_busy || !_active || input == null || input.logins.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _skipped = input.skipped;
      _input = null;
    });
    try {
      final result = await widget.repository.import(input);
      if (mounted) setState(() => _result = result);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Import was not confirmed. Refresh Vault before choosing the file again.',
        );
      }
    } finally {
      input.clear();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _generation++;
    _clear();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Import passwords')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text(
          'Choose a CSV exported from Chrome, 1Password, or another password manager. The export is not encrypted. Delete it after importing.',
        ),
        const SizedBox(height: 16),
        const Text(
          '1Password app integration runs beside your Nod server, not on this phone. To select a login through its desktop helper, open the task’s private Sign in request. A phone-local integration is not provided.',
        ),
        if (_result == null) ...[
          OutlinedButton(
            onPressed: _busy ? null : _choose,
            child: const Text('Choose CSV file'),
          ),
          if (_input != null)
            Text(
              '${_input!.logins.length} logins ready · ${_input!.skipped} skipped',
            ),
          FilledButton(
            onPressed: _busy || _input == null || _input!.logins.isEmpty
                ? null
                : _submit,
            child: Text(_busy ? 'Working' : 'Import'),
          ),
        ] else ...[
          Text(
            'Imported ${_result!['imported']} · ${_result!['existing']} already saved · ${(_result!['skipped']! as num) + _skipped} skipped · ${_result!['authenticatorKeys']} with authenticator keys',
          ),
          const Text('Now delete the exported file. It is not encrypted.'),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
        if (_error != null) Text(_error!),
      ],
    ),
  );
}
