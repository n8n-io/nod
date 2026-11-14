import 'package:flutter/material.dart';

import '../../core/nod_errors.dart';

String settingsError(Object error) => error is NodException
    ? error.message
    : 'The change could not be completed. Review the details and try again.';

Future<bool> confirmSettings(
  BuildContext context,
  String title,
  String detail,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(detail),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Continue'),
          ),
        ],
      ),
    ) ??
    false;

class SettingsSection extends StatefulWidget {
  const SettingsSection({
    super.key,
    required this.title,
    required this.load,
    required this.builder,
  });
  final String title;
  final Future<Map<String, Object?>> Function() load;
  final Widget Function(
    BuildContext,
    Map<String, Object?>,
    SettingsSectionState,
  )
  builder;
  @override
  State<SettingsSection> createState() => SettingsSectionState();
}

class SettingsSectionState extends State<SettingsSection> {
  Map<String, Object?>? data;
  String? error;
  bool busy = false;
  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() => run(() async {
    final next = await widget.load();
    if (mounted) setState(() => data = next);
  });
  Future<bool> run(Future<void> Function() action) async {
    if (busy) return false;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
      return true;
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
      return false;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> change(Future<Object?> Function() action) => run(() async {
    await action();
    final next = await widget.load();
    if (mounted) setState(() => data = next);
  });
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.title),
      actions: [
        IconButton(
          onPressed: busy ? null : reload,
          icon: const Icon(Icons.refresh),
          tooltip: 'Reload',
        ),
      ],
    ),
    body: Column(
      children: [
        if (busy) const LinearProgressIndicator(),
        if (error != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(error!, semanticsLabel: 'Error: $error'),
          ),
        Expanded(
          child: data == null
              ? Center(
                  child: busy
                      ? const CircularProgressIndicator()
                      : FilledButton(
                          onPressed: reload,
                          child: const Text('Try again'),
                        ),
                )
              : AbsorbPointer(
                  absorbing: busy,
                  child: widget.builder(context, data!, this),
                ),
        ),
      ],
    ),
  );
}

class SettingsEditPage extends StatefulWidget {
  const SettingsEditPage({
    super.key,
    required this.title,
    required this.fields,
    required this.save,
    this.secretFields = const {},
    this.limits = const {},
    this.multiline = const {},
    this.help,
  });
  final String title;
  final Map<String, String> fields;
  final Set<String> secretFields;
  final Set<String> multiline;
  final Map<String, int> limits;
  final String? help;
  final Future<void> Function(Map<String, String>) save;
  @override
  State<SettingsEditPage> createState() => _SettingsEditPageState();
}

class _SettingsEditPageState extends State<SettingsEditPage> {
  late final fields = {
    for (final entry in widget.fields.entries)
      entry.key: TextEditingController(text: entry.value),
  };
  bool busy = false;
  String? error;
  bool get dirty => fields.entries.any(
    (entry) => entry.value.text != widget.fields[entry.key],
  );
  @override
  void dispose() {
    for (final controller in fields.values) {
      controller.clear();
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> save() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.save({
        for (final entry in fields.entries) entry.key: entry.value.text,
      });
      if (mounted) Navigator.pop(context, true);
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !busy && !dirty,
    onPopInvokedWithResult: (didPop, result) async {
      if (didPop || busy) return;
      if (await confirmSettings(
            context,
            'Discard changes?',
            'Your unsaved changes will be lost.',
          ) &&
          context.mounted) {
        Navigator.pop(context);
      }
    },
    child: Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (widget.help != null) Text(widget.help!),
          for (final entry in fields.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: TextField(
                controller: entry.value,
                enabled: !busy,
                obscureText: widget.secretFields.contains(entry.key),
                autocorrect: !widget.secretFields.contains(entry.key),
                enableSuggestions: !widget.secretFields.contains(entry.key),
                enableIMEPersonalizedLearning: !widget.secretFields.contains(
                  entry.key,
                ),
                maxLines: widget.multiline.contains(entry.key) ? 8 : 1,
                maxLength: widget.limits[entry.key],
                decoration: InputDecoration(labelText: entry.key),
                onChanged: (_) => setState(() {}),
              ),
            ),
          if (error != null) Text(error!),
          FilledButton(
            onPressed: busy ? null : save,
            child: Text(busy ? 'Saving' : 'Save'),
          ),
        ],
      ),
    ),
  );
}

Future<bool> editSettings(BuildContext context, SettingsEditPage page) async =>
    await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => page),
    ) ??
    false;
