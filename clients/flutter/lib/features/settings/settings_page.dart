import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/settings_repository.dart';
import '../../core/api_transport.dart';
import '../../core/settings.dart';
import 'memory_settings_page.dart';
import 'model_settings_page.dart';
import 'settings_media.dart';
import 'settings_widgets.dart';

class NodSettingsPage extends StatelessWidget {
  const NodSettingsPage({
    super.key,
    required this.transport,
    this.onThemeChanged,
    this.onShowMessage,
    this.initialSection,
  });
  final String? initialSection;
  final NodApiTransport transport;
  final ValueChanged<ThemeMode>? onThemeChanged;
  final ValueChanged<String>? onShowMessage;
  @override
  Widget build(BuildContext context) {
    final repository = NodSettingsRepository(transport);
    final section = switch (initialSection) {
      'models' => NodModelSettingsPage(repository: repository),
      'voice' => NodVoiceSettingsPage(repository: repository),
      'memory' => NodMemorySettingsPage(
        repository: repository,
        onShowMessage: onShowMessage,
      ),
      'privacy' => _privacy(repository),
      _ => null,
    };
    if (section != null) return section;
    void open(Widget page) =>
        Navigator.push(context, MaterialPageRoute<void>(builder: (_) => page));
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          ListTile(
            title: const Text('General'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => open(_general(repository, onThemeChanged)),
          ),
          ListTile(
            title: const Text('Models'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => open(NodModelSettingsPage(repository: repository)),
          ),
          ListTile(
            title: const Text('Voice & audio'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => open(NodVoiceSettingsPage(repository: repository)),
          ),
          ListTile(
            title: const Text('Memory'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => open(
              NodMemorySettingsPage(
                repository: repository,
                onShowMessage: onShowMessage,
              ),
            ),
          ),
          ListTile(
            title: const Text('Rules & task check-ins'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => open(_rules(repository)),
          ),
          ListTile(
            title: const Text('Privacy & data'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => open(_privacy(repository)),
          ),
        ],
      ),
    );
  }
}

Widget _general(
  NodSettingsRepository repository,
  ValueChanged<ThemeMode>? onThemeChanged,
) => SettingsSection(
  title: 'General',
  load: () async => {
    'session': await repository.session(),
    'preferences': await repository.preferences(),
  },
  builder: (context, data, state) {
    final account = settingsMap(settingsMap(data['session'])['settings']);
    final preferences = settingsMap(data['preferences']);
    return ListView(
      children: [
        ListTile(
          title: const Text('Appearance'),
          subtitle: const Text('Shared with your paired Nod server.'),
          trailing: DropdownButton<String>(
            value: account['theme'] as String,
            items: ['system', 'light', 'dark']
                .map(
                  (value) => DropdownMenuItem(value: value, child: Text(value)),
                )
                .toList(),
            onChanged: (value) => state.change(() async {
              final result = await repository.saveAccount({'theme': value});
              onThemeChanged?.call(switch (value) {
                'light' => ThemeMode.light,
                'dark' => ThemeMode.dark,
                _ => ThemeMode.system,
              });
              return result;
            }),
          ),
        ),
        for (final field in ['timeZone', 'locale'])
          ListTile(
            title: Text(field == 'timeZone' ? 'Time zone' : 'Region'),
            subtitle: Text(preferences[field] as String? ?? 'Automatic'),
            onTap: () async {
              if (await editSettings(
                context,
                SettingsEditPage(
                  title: field == 'timeZone' ? 'Time zone' : 'Region',
                  fields: {field: preferences[field] as String? ?? ''},
                  help: field == 'timeZone'
                      ? 'Use an IANA zone such as Europe/London. Leave empty for automatic.'
                      : 'Use a locale such as en-GB. This controls formatting, not reply language. Leave empty for automatic.',
                  save: (values) async {
                    await repository.savePreferences({
                      field: values[field]!.trim().isEmpty
                          ? null
                          : values[field]!.trim(),
                    });
                  },
                ),
              )) {
                await state.reload();
              }
            },
          ),
        ListTile(
          title: const Text('Clock format'),
          trailing: DropdownButton<String>(
            value: preferences['hourCycle'] as String,
            items: ['auto', 'h12', 'h23']
                .map(
                  (value) => DropdownMenuItem(value: value, child: Text(value)),
                )
                .toList(),
            onChanged: (value) => state.change(
              () => repository.savePreferences({'hourCycle': value}),
            ),
          ),
        ),
        for (final link in {
          'Discord': 'https://discord.gg/n8n',
          'Forum': 'https://community.n8n.io/c/n8n-labs/48',
        }.entries)
          ListTile(
            title: Text(link.key),
            trailing: const Icon(Icons.open_in_new),
            onTap: () => state.run(() async {
              if (!await launchUrl(
                Uri.parse(link.value),
                mode: LaunchMode.externalApplication,
              )) {
                throw const FormatException();
              }
            }),
          ),
      ],
    );
  },
);

Widget _rules(NodSettingsRepository repository) => SettingsSection(
  title: 'Rules & task check-ins',
  load: () async => {
    'preferences': await repository.preferences(),
    'usage': await repository.usage(),
  },
  builder: (context, data, state) {
    final preferences = settingsMap(data['preferences']);
    final taskUsd = settingsMap(data['usage'])['taskUsd'];
    return ListView(
      children: [
        ListTile(
          title: const Text('Your rules'),
          subtitle: Text(
            (preferences['rules'] as String).isEmpty
                ? 'Set lasting instructions for actions Nod may take or must ask about.'
                : preferences['rules'] as String,
          ),
          onTap: () async {
            if (await editSettings(
              context,
              SettingsEditPage(
                title: 'Your rules',
                fields: {'Rules': preferences['rules'] as String},
                multiline: const {'Rules'},
                limits: const {'Rules': 4000},
                help: 'Rules to ask first override other permission. Rules never authorize Nod to change its own settings.',
                save: (values) async {
                  await repository.savePreferences({'rules': values['Rules']});
                },
              ),
            )) {
              await state.reload();
            }
          },
        ),
        ListTile(
          title: const Text('Task check-in'),
          subtitle: Text(
            taskUsd == null
                ? 'Off'
                : '\$$taskUsd per session since your last message',
          ),
          onTap: () async {
            if (await editSettings(
              context,
              SettingsEditPage(
                title: 'Task check-in',
                fields: {'USD': taskUsd?.toString() ?? ''},
                help: 'Minimum \$1, at most two decimals. Leave empty to turn off. Plan usage counts at its API-price estimate. Each session waits for your reply when it passes this amount.',
                save: (values) async {
                  final value = values['USD']!.trim();
                  final amount = value.isEmpty ? null : double.parse(value);
                  await repository.taskCheckIn(amount);
                },
              ),
            )) {
              await state.reload();
            }
          },
        ),
      ],
    );
  },
);

class NodVoiceSettingsPage extends StatefulWidget {
  const NodVoiceSettingsPage({
    super.key,
    required this.repository,
    this.preview,
  });
  final NodSettingsRepository repository;
  final SettingsVoicePreview? preview;
  @override
  State<NodVoiceSettingsPage> createState() => _NodVoiceSettingsPageState();
}

class _NodVoiceSettingsPageState extends State<NodVoiceSettingsPage>
    with WidgetsBindingObserver {
  late final preview =
      widget.preview ?? SettingsVoicePreview(repository: widget.repository);
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(preview.stop());
  }

  @override
  void deactivate() {
    unawaited(preview.stop());
    super.deactivate();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    preview.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: preview,
    builder: (context, _) => _voice(widget.repository, preview),
  );
}

Widget _voice(
  NodSettingsRepository repository,
  SettingsVoicePreview preview,
) => SettingsSection(
  title: 'Voice & audio',
  load: repository.speech,
  builder: (context, data, state) {
    final localReady =
        data['local'] != null && settingsMap(data['local'])['state'] == 'ready';
    final voices = settingsRows(data['voices'])
        .where(
          (voice) =>
              !(voice['source'] == 'local' ||
                  (voice['id'] as String).startsWith('local:')) ||
              localReady,
        )
        .toList();
    return ListView(
      children: [
        ListTile(
          title: const Text('Speech recognition'),
          subtitle: Text(
            data['transcription'] == true
                ? 'Available on your Nod server'
                : 'Not ready on your Nod server',
          ),
        ),
        ListTile(
          title: const Text('Spoken replies'),
          trailing: DropdownButton<String>(
            value: data['speechReply'] as String,
            items: const [
              DropdownMenuItem(value: 'auto', child: Text('Auto')),
              DropdownMenuItem(value: 'voice', child: Text('After audio')),
              DropdownMenuItem(value: 'always', child: Text('Always')),
              DropdownMenuItem(value: 'never', child: Text('Off')),
            ],
            onChanged: (value) => state.change(
              () => repository.savePreferences({'speechReply': value}),
            ),
          ),
        ),
        RadioGroup<String>(
          groupValue: data['speechVoice'] as String? ?? '',
          onChanged: (value) => state.change(() async {
            await preview.stop();
            return repository.savePreferences({
              'speechVoice': value == '' ? null : value,
            });
          }),
          child: Column(
            children: [
              const RadioListTile(value: '', title: Text('Automatic voice')),
              for (final voice in voices)
                RadioListTile(
                  value: voice['id'] as String,
                  title: Text(voice['name'] as String),
                  subtitle: Text(
                    '${voice['engine']} · ${voice['description']}',
                  ),
                ),
            ],
          ),
        ),
        ListTile(
          title: const Text('Voice preview'),
          subtitle: Text(
            preview.error ??
                (preview.loading
                    ? 'Preparing preview. Stop discards the result; the request is not retried.'
                    : preview.playing
                    ? 'Playing preview'
                    : 'Hear the selected voice.'),
          ),
          trailing: TextButton.icon(
            onPressed: preview.loading || preview.playing
                ? preview.stop
                : () => preview.start(
                    data['speechVoice'] as String?,
                    Localizations.localeOf(context).toLanguageTag(),
                  ),
            icon: Icon(
              preview.loading || preview.playing
                  ? Icons.stop
                  : Icons.play_arrow,
            ),
            label: Text(
              preview.loading || preview.playing
                  ? 'Stop preview'
                  : 'Preview voice',
            ),
          ),
        ),
        if (data['voicesError'] != null)
          const ListTile(
            title: Text(
              'Some voices could not be loaded. Refresh the catalog.',
            ),
          ),
        ListTile(
          title: const Text('Refresh voice catalog'),
          trailing: const Icon(Icons.refresh),
          onTap: () => state.change(repository.refreshVoices),
        ),
        if (data['local'] != null)
          ListTile(
            title: const Text('Free audio on your Nod server'),
            subtitle: Text(
              'State: ${settingsMap(data['local'])['state']}. Downloads run on the server, not this phone.',
            ),
            onTap: () async {
              if (await confirmSettings(
                context,
                'Download free audio?',
                'Download voice and recognition models on the computer running Nod?',
              )) {
                await state.change(
                  () => repository.prepareSpeech(
                    Localizations.localeOf(context).toLanguageTag(),
                  ),
                );
              }
            },
          ),
        const ListTile(
          title: Text('Microphone'),
          subtitle: Text(
            'Recording uses the system microphone. Grant microphone permission when recording in chat. Manage denied permission in device settings.',
          ),
        ),
      ],
    );
  },
);

Widget _privacy(NodSettingsRepository repository) => SettingsSection(
  title: 'Privacy & data',
  load: () async => {
    'session': await repository.session(),
    'state': await repository.state(),
  },
  builder: (context, data, state) {
    final session = settingsMap(data['session']);
    final account = settingsMap(session['settings']);
    final capabilities = settingsMap(session['capabilities']);
    final appState = settingsMap(data['state']);
    final configuration = settingsMap(appState['configuration']);
    Future<void> share(String key, bool value) async {
      if (value &&
          !await confirmSettings(
            context,
            key == 'traces'
                ? 'Share conversation traces?'
                : 'Share usage data?',
            key == 'traces'
                ? 'Send conversations, including what Nod reads and does, to n8n. Recognized personal details are removed first, but traces are not anonymous. Stored in the EU for 14 days, never used for model training.'
                : 'Share feature usage, timings, costs, and onboarding answers with n8n. Messages and screen recordings are excluded. An email you previously consented to share can be linked to this installation.',
          )) {
        return;
      }
      await state.change(() => repository.saveAccount({key: value}));
    }

    return ListView(
      children: [
        SwitchListTile(
          title: const Text('Share usage data'),
          subtitle: const Text(
            'Turning off stops new sends. Previously stored data is deleted by request.',
          ),
          value: account['usageData'] == true,
          onChanged: (value) => share('usageData', value),
        ),
        if (capabilities['traces'] == true)
          SwitchListTile(
            title: const Text('Share conversation traces'),
            subtitle: const Text(
              'Includes conversation content. Pseudonymised, not anonymous.',
            ),
            value: account['traces'] == true,
            onChanged: (value) => share('traces', value),
          ),
        if (configuration['conversationResetEnabled'] == true)
          ListTile(
            title: const Text('Reset conversation'),
            subtitle: const Text(
              'Start a new conversation and stop current work. Memory is kept.',
            ),
            onTap: () async {
              final threadId = settingsText(appState, 'threadId');
              if (await confirmSettings(
                context,
                'Reset conversation?',
                'This stops current work and starts a fresh conversation. Existing memory is kept.',
              )) {
                await state.change(
                  () => repository.resetConversation(threadId),
                );
              }
            },
          ),
        const ListTile(
          title: Text('Remove all data'),
          subtitle: Text(
            'This is a desktop-only operation. On a self-hosted server, its administrator must stop Nod and remove its data. Mobile does not erase the paired server.',
          ),
        ),
        const ListTile(
          title: Text('Request deletion of shared data'),
          subtitle: Text(
            'Contact privacy@n8n.io. Turning sharing off does not delete data already sent.',
          ),
        ),
      ],
    );
  },
);
