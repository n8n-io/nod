import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/settings_repository.dart';
import '../../core/nod_errors.dart';
import '../../core/settings.dart';
import 'settings_widgets.dart';

const _providers = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'amazon-bedrock',
  'google-vertex',
  'azure',
  'ant-ling',
  'baseten',
  'cerebras',
  'cloudflare-workers-ai',
  'cloudflare-ai-gateway',
  'deepseek',
  'fireworks',
  'groq',
  'huggingface',
  'kimi-coding',
  'meta',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'opencode',
  'opencode-go',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'radius',
  'together',
  'vercel-ai-gateway',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-cn',
  'elevenlabs',
  'compatible',
];

String _connectionIdentity(Map<String, Object?> connection) {
  final label = settingsText(connection, 'label');
  final ending = connection['keyEnding'];
  return ending is String && ending.isNotEmpty
      ? '$label · Key …$ending'
      : label;
}

class NodModelSettingsPage extends StatefulWidget {
  const NodModelSettingsPage({super.key, required this.repository});
  final NodSettingsRepository repository;
  @override
  State<NodModelSettingsPage> createState() => _NodModelSettingsPageState();
}

class _NodModelSettingsPageState extends State<NodModelSettingsPage> {
  String search = '';
  NodSettingsRepository get repository => widget.repository;
  Future<void> connect(
    BuildContext context,
    SettingsSectionState state,
    String provider,
  ) async {
    final extras = switch (provider) {
      'amazon-bedrock' => {'Region': 'region'},
      'azure' => {
        'Endpoint': 'url',
        'Deployment': 'deployment',
        'Model ID': 'model',
      },
      'cloudflare-workers-ai' => {'Account ID': 'accountId'},
      'cloudflare-ai-gateway' => {
        'Account ID': 'accountId',
        'Gateway ID': 'gatewayId',
      },
      'anthropic' => {'Workspace ID (optional)': 'workspaceId'},
      'compatible' => {'Server address': 'url'},
      _ => <String, String>{},
    };
    if (await editSettings(
      context,
      SettingsEditPage(
        title: 'Connect $provider',
        fields: {
          'API key': '',
          for (final field in extras.keys)
            field: field == 'Server address' ? 'http://localhost:11434/v1' : '',
        },
        secretFields: const {'API key'},
        help: 'Your key goes only to the paired Nod server and this provider, never to chat. Server addresses refer to the computer running Nod. API keys are required except for OpenAI-compatible servers. For Anthropic, enter a workspace ID if your key needs one.',
        save: (values) async {
          await repository.connectProvider({
            'provider': provider,
            if (values['API key']!.trim().isNotEmpty)
              'key': values['API key']!.trim(),
            for (final entry in extras.entries)
              if (values[entry.key]!.trim().isNotEmpty)
                entry.value: values[entry.key]!.trim(),
          });
        },
      ),
    )) {
      await state.reload();
    }
  }

  Future<void> signIn(
    BuildContext context,
    SettingsSectionState state,
    String provider, {
    String? connectionId,
  }) async {
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => _ModelSignInPage(
          repository: repository,
          provider: provider,
          connectionId: connectionId,
        ),
      ),
    );
    await state.reload();
  }

  @override
  Widget build(BuildContext context) => SettingsSection(
    title: 'Models',
    load: repository.models,
    builder: (context, data, state) {
      final selection = data['selection'] == null
          ? null
          : settingsMap(data['selection']);
      final connections = settingsRows(data['connections']);
      return ListView(
        padding: const EdgeInsets.all(12),
        children: [
          const Text(
            'Choose the model and connection Nod uses next. Running tasks keep their original model. Connecting checks provider access and may contact that service.',
          ),
          ExpansionTile(
            title: const Text('Add connection'),
            children: [
              for (final provider in _providers)
                ListTile(
                  title: Text(provider),
                  onTap: () => connect(context, state, provider),
                  trailing: ['openai', 'openrouter'].contains(provider)
                      ? TextButton(
                          onPressed: () => signIn(context, state, provider),
                          child: Text(
                            provider == 'openai'
                                ? 'ChatGPT sign-in'
                                : 'Browser sign-in',
                          ),
                        )
                      : null,
                ),
            ],
          ),
          TextField(
            decoration: const InputDecoration(
              labelText: 'Search models and connections',
            ),
            onChanged: (value) => setState(() => search = value.toLowerCase()),
          ),
          for (final connection in connections)
            Card(
              child: ExpansionTile(
                initiallyExpanded: true,
                title: Text(
                  '${connection['provider']} · ${_connectionIdentity(connection)}',
                ),
                subtitle: Text(
                  '${connection['status']}${connection['managed'] == true ? ' · Managed by server' : ''}',
                ),
                children: [
                  for (final model in settingsRows(connection['models']).where(
                    (model) =>
                        '${model['name']} ${model['id']} ${connection['provider']} ${_connectionIdentity(connection)}'
                            .toLowerCase()
                            .contains(search),
                  ))
                    ListTile(
                      title: Text(settingsText(model, 'name')),
                      subtitle: Text(
                        '${model['id']}\n${model['contextWindow']} tokens${model['images'] == true ? ' · Images' : ''}${model['audio'] == true ? ' · Audio' : ''}${model['textModelName'] != null ? '\nText support: ${model['textModelName']}' : ''}${model['pricing'] != null ? '\nUSD per million tokens: ${model['pricing']}' : ''}',
                      ),
                      leading:
                          selection?['connectionId'] == connection['id'] &&
                              selection?['modelId'] == model['id']
                          ? const Icon(Icons.check_circle)
                          : const Icon(Icons.circle_outlined),
                      onTap: () async {
                        final efforts = (model['efforts'] as List)
                            .cast<String>();
                        final effort = efforts.isEmpty
                            ? 'off'
                            : await showDialog<String>(
                                context: context,
                                builder: (context) => SimpleDialog(
                                  title: const Text('Reasoning effort'),
                                  children: [
                                    for (final effort in efforts)
                                      SimpleDialogOption(
                                        onPressed: () =>
                                            Navigator.pop(context, effort),
                                        child: Text(effort),
                                      ),
                                  ],
                                ),
                              );
                        if (effort != null) {
                          await state.change(
                            () => repository.selectModel(
                              settingsText(connection, 'id'),
                              settingsText(model, 'id'),
                              effort,
                            ),
                          );
                        }
                      },
                    ),
                  Wrap(
                    children: [
                      TextButton(
                        onPressed: () => state.change(
                          () => repository.refreshConnection(
                            settingsText(connection, 'id'),
                          ),
                        ),
                        child: const Text('Load models'),
                      ),
                      if (connection['managed'] != true) ...[
                        if (connection['method'] == 'subscription' ||
                            connection['method'] == 'oauth')
                          TextButton(
                            onPressed: () => signIn(
                              context,
                              state,
                              settingsText(connection, 'provider'),
                              connectionId: settingsText(connection, 'id'),
                            ),
                            child: const Text('Reconnect'),
                          ),
                        TextButton(
                          onPressed: () async {
                            if (await confirmSettings(
                              context,
                              'Remove connection?',
                              'Remove ${_connectionIdentity(connection)}? If selected, choose a new model before continuing.',
                            )) {
                              await state.change(
                                () => repository.removeConnection(
                                  settingsText(connection, 'id'),
                                ),
                              );
                            }
                          },
                          child: const Text('Remove connection'),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
        ],
      );
    },
  );
}

class _ModelSignInPage extends StatefulWidget {
  const _ModelSignInPage({
    required this.repository,
    required this.provider,
    this.connectionId,
  });
  final NodSettingsRepository repository;
  final String provider;
  final String? connectionId;
  @override
  State<_ModelSignInPage> createState() => _ModelSignInPageState();
}

class _ModelSignInPageState extends State<_ModelSignInPage> {
  String? attempt;
  Uri? url;
  Timer? timer;
  bool busy = false;
  bool connected = false;
  String? error;
  final callback = TextEditingController();
  @override
  void initState() {
    super.initState();
    start();
  }

  @override
  void dispose() {
    timer?.cancel();
    callback.clear();
    callback.dispose();
    final pending = attempt;
    if (pending != null && !connected) {
      unawaited(
        widget.repository
            .cancelSignIn(pending)
            .catchError((_) => <String, Object?>{}),
      );
    }
    super.dispose();
  }

  Future<void> start() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.repository.startSignIn(
        widget.provider,
        connectionId: widget.connectionId,
      );
      final pending = settingsText(result, 'attempt');
      if (!mounted) {
        await widget.repository.cancelSignIn(pending);
        return;
      }
      attempt = pending;
      final target = Uri.parse(settingsText(result, 'url'));
      if (target.scheme != 'https' ||
          target.host.isEmpty ||
          target.userInfo.isNotEmpty) {
        throw const NodProtocolException();
      }
      url = target;
      timer = Timer.periodic(const Duration(seconds: 2), (_) => poll());
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> poll() async {
    if (busy || attempt == null || connected) return;
    setState(() => busy = true);
    try {
      final status = await widget.repository.signInStatus(attempt!);
      if (!mounted) return;
      if (status['status'] == 'connected') {
        timer?.cancel();
        setState(() => connected = true);
      } else if (status['status'] == 'failed') {
        timer?.cancel();
        setState(
          () => error = 'Sign-in failed or expired. Return to Models and start a new connection.',
        );
      }
    } catch (cause) {
      timer?.cancel();
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> complete() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.repository.completeSignIn(callback.text.trim());
      callback.clear();
    } catch (cause) {
      if (mounted) setState(() => error = settingsError(cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
    await poll();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('${widget.provider} sign-in')),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (connected) ...[
          const Text('Connection saved.'),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ] else ...[
          const Text(
            'Open the provider in your browser. Only its sign-in address is opened; your Nod access token is never passed to the browser. Return here after signing in. Leaving this page cancels the pending attempt.',
          ),
          if (url != null)
            FilledButton(
              onPressed: () async {
                try {
                  if (!await launchUrl(
                    url!,
                    mode: LaunchMode.externalApplication,
                  )) {
                    throw const NodRequestException();
                  }
                } catch (_) {
                  if (mounted) {
                    setState(
                      () => error = 'Could not open the provider browser.',
                    );
                  }
                }
              },
              child: const Text('Open sign-in'),
            ),
          if (widget.provider == 'openai') ...[
            const Text(
              'If the browser ends at a page that cannot load, paste its full callback address privately here.',
            ),
            TextField(
              controller: callback,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              enableIMEPersonalizedLearning: false,
              decoration: const InputDecoration(labelText: 'Callback URL'),
            ),
            TextButton(
              onPressed: busy || attempt == null ? null : complete,
              child: const Text('Complete sign-in'),
            ),
          ],
          TextButton(
            onPressed: busy || attempt == null ? null : poll,
            child: const Text('Check status'),
          ),
          if (busy) const LinearProgressIndicator(),
        ],
        if (error != null) Text(error!),
      ],
    ),
  );
}
