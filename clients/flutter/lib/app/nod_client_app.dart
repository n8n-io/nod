import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api.dart';
import '../core/api_transport.dart';
import '../core/app_connections.dart';
import '../core/core.dart';
import '../core/mobile_links.dart';
import '../core/onboarding.dart';
import '../core/private_requests.dart';
import '../core/schedules.dart';
import '../core/usage.dart';
import '../design_system/design_system.dart';
import '../features/apps/apps_page.dart';
import '../features/chat/chat.dart';
import '../features/connections/connections_page.dart';
import '../features/onboarding/notification_settings_page.dart';
import '../features/onboarding/onboarding_page.dart';
import '../features/prepared/prepared_page.dart';
import '../features/private_requests/private_requests_page.dart';
import '../features/scheduled/scheduled_page.dart';
import '../features/settings/settings_page.dart';
import '../features/tasks/tasks_page.dart';
import '../features/usage/usage_page.dart';
import '../features/vault/vault_page.dart';
import '../motion/motion.dart';

class NodClientApp extends StatefulWidget {
  const NodClientApp({
    super.key,
    this.repository,
    this.restoreConnection,
    this.disposeRepository = true,
    this.themeMode = ThemeMode.system,
    this.linkSource,
  });

  final NodRepository? repository;
  final Future<bool> Function()? restoreConnection;
  final bool disposeRepository;
  final ThemeMode themeMode;
  final NodMobileLinkSource? linkSource;

  @override
  State<NodClientApp> createState() => _NodClientAppState();
}

class _NodClientAppState extends State<NodClientApp> {
  late final NodRepository _repository;
  final _navigatorKey = GlobalKey<NavigatorState>();
  var _restoring = true;
  var _connected = false;
  var _needsOnboarding = false;
  var _selectedIndex = 0;
  String? _focusMessageId;
  ThemeMode? _accountTheme;
  var _themeEpoch = 0;
  String? _connectionError;
  NodMobileLinkSource? _links;
  StreamSubscription<Uri>? _linkSubscription;
  Future<Uri?>? _initialLink;
  String? _lastLink;
  DateTime? _lastLinkAt;

  @override
  void initState() {
    super.initState();
    _repository = widget.repository ?? HttpNodRepository();
    _links =
        widget.linkSource ??
        (_repository is HttpNodRepository
            ? NodPlatformMobileLinkSource()
            : null);
    _initialLink = _primeLinks();
    unawaited(_restore());
  }

  Future<void> _restore() async {
    try {
      final restored = widget.restoreConnection != null
          ? await widget.restoreConnection!()
          : _repository is HttpNodRepository
          ? await _repository.connectStored()
          : false;
      if (restored) await _loadSession();
      if (!mounted) return;
      setState(() {
        _connected = restored;
        _restoring = false;
      });
      if (restored && !_needsOnboarding) unawaited(_restoreInitialLink());
    } on NodException catch (error) {
      if (!mounted) return;
      setState(() {
        _connectionError = error.message;
        _restoring = false;
      });
    }
  }

  Future<void> _connect(NodConnectionConfig config) async {
    _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    ++_themeEpoch;
    setState(() => _connectionError = null);
    try {
      await _repository.connect(config);
      await _loadSession();
      if (!mounted) return;
      setState(() {
        _connected = true;
        _selectedIndex = 0;
      });
    } on NodException catch (error) {
      if (!mounted) return;
      setState(() => _connectionError = error.message);
      rethrow;
    }
  }

  Future<void> _loadSession() async {
    final epoch = ++_themeEpoch;
    final repository = _repository;
    if (repository is! NodApiTransport) return;
    final value = await (repository as NodApiTransport).requestJson(
      'GET',
      '/api/session',
    );
    final settings = value is Map ? value['settings'] : null;
    if (!mounted || epoch != _themeEpoch) return;
    if (settings is! Map || settings['onboardingCompleted'] is! bool) {
      throw const NodProtocolException();
    }
    _needsOnboarding = settings['onboardingCompleted'] == false;
    _accountTheme = switch (settings['theme']) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
  }

  Future<void> _completeOnboarding() async {
    setState(() => _restoring = true);
    try {
      await _loadSession();
      if (mounted) setState(() => _restoring = false);
    } on NodException catch (error) {
      if (!mounted) return;
      setState(() {
        _connected = false;
        _restoring = false;
        _connectionError = error.message;
      });
    }
  }

  Future<Uri?> _primeLinks() async {
    final source = _links;
    if (source == null) return null;
    Uri? initial;
    try {
      initial = await source.initialUri().timeout(const Duration(seconds: 3));
    } on Object {
      initial = null;
    }
    if (!mounted) return null;
    var startupReplayPending = initial != null;
    _linkSubscription = source.uris.listen((uri) {
      if (startupReplayPending && uri == initial) {
        startupReplayPending = false;
        return;
      }
      _openLink(uri);
    }, onError: (Object _) {});
    return initial;
  }

  Future<void> _restoreInitialLink() async {
    final epoch = _themeEpoch;
    try {
      final uri = await _initialLink;
      if (uri != null && mounted && epoch == _themeEpoch) _openLink(uri);
    } on Object {
      return;
    }
  }

  Future<void> _askFromVault(String text) async {
    if (!mounted || !_connected || _restoring || _needsOnboarding) return;
    final scope = _repository is NodConnectionScope
        ? _repository as NodConnectionScope
        : null;
    final generation = scope?.connectionGeneration;
    _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    setState(() {
      _focusMessageId = null;
      _selectedIndex = 0;
    });
    try {
      await _repository.sendText(
        text,
        clientMessageId: newNodClientMessageId(),
      );
    } on Object {
      if (!mounted ||
          !_connected ||
          scope?.connectionGeneration != generation) {
        return;
      }
      final context = _navigatorKey.currentContext;
      if (context != null && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'This request could not be confirmed. Check the chat before sending it again.',
            ),
          ),
        );
      }
    }
  }

  void _showMessage(String id) {
    _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    setState(() {
      _focusMessageId = id;
      _selectedIndex = 0;
    });
  }

  void _openLink(Uri uri) {
    if (!mounted || !_connected || _restoring || _needsOnboarding) return;
    final repository = _repository;
    if (repository is! NodApiTransport || repository is! NodPairedOrigin) {
      return;
    }
    final origin = (repository as NodPairedOrigin).pairedOrigin;
    if (origin == null) return;
    final route = NodMobileRoute.parse(
      uri.toString(),
      pairedOrigin: origin,
      authenticated: true,
    );
    if (route == null) return;
    final now = DateTime.now();
    if (_lastLink == uri.toString() &&
        _lastLinkAt != null &&
        now.difference(_lastLinkAt!) < const Duration(seconds: 2)) {
      return;
    }
    _lastLink = uri.toString();
    _lastLinkAt = now;
    final transport = repository as NodApiTransport;
    final index = switch (route.destination) {
      NodMobileDestination.chat => 0,
      NodMobileDestination.apps => 2,
      NodMobileDestination.usage => 3,
      NodMobileDestination.tasks => 4,
      NodMobileDestination.settings => 7,
      NodMobileDestination.vault => 8,
      NodMobileDestination.notifications => 9,
      _ => null,
    };
    _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    if (index != null) {
      setState(() {
        _focusMessageId = null;
        _selectedIndex = index;
      });
      return;
    }
    final page = switch (route.destination) {
      NodMobileDestination.prepared => Scaffold(
        appBar: AppBar(title: const Text('Prepared work')),
        body: NodPreparedPage(transport: transport, issueId: route.id),
      ),
      NodMobileDestination.credentials ||
      NodMobileDestination.payment => NodPrivateRequestsPage(
        transport: transport,
        initialRequest: NodPrivateRequestRef.fromLink(uri.path),
      ),
      NodMobileDestination.browser => NodPrivateRequestsPage(
        transport: transport,
      ),
      NodMobileDestination.channels => NodConnectionsPage(transport: transport),
      NodMobileDestination.models ||
      NodMobileDestination.voice ||
      NodMobileDestination.memory ||
      NodMobileDestination.privacy => NodSettingsPage(
        transport: transport,
        initialSection: route.destination.name,
        onShowMessage: _showMessage,
        onThemeChanged: (value) {
          ++_themeEpoch;
          setState(() => _accountTheme = value);
        },
      ),
      _ => null,
    };
    if (page != null) {
      _navigatorKey.currentState?.push(
        MaterialPageRoute<void>(builder: (_) => page),
      );
    }
  }

  Future<void> _logOut() async {
    _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    ++_themeEpoch;
    setState(() => _connected = false);
    _lastLink = null;
    _lastLinkAt = null;
    if (_repository case final HttpNodRepository repository) {
      await repository.forgetCredentials();
    }
    await _repository.disconnect();
    if (!mounted) return;
    setState(() {
      _connected = false;
      _connectionError = null;
      _focusMessageId = null;
      _accountTheme = null;
    });
  }

  @override
  void dispose() {
    unawaited(_linkSubscription?.cancel());
    if (widget.disposeRepository && _repository is HttpNodRepository) {
      unawaited(_repository.dispose());
    } else if (widget.disposeRepository) {
      unawaited(_repository.disconnect());
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nod',
      navigatorKey: _navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: NodTheme.light,
      darkTheme: NodTheme.dark,
      themeMode: _accountTheme ?? widget.themeMode,
      home: NodMotionLifecycle(
        child: _restoring
            ? const _RestoringConnection()
            : _connected && _needsOnboarding && _repository is NodApiTransport
            ? NodMobileOnboarding(
                transport: _repository as NodApiTransport,
                onComplete: () => unawaited(_completeOnboarding()),
              )
            : _connected
            ? _ConnectedShell(
                repository: _repository,
                selectedIndex: _selectedIndex,
                focusMessageId: _focusMessageId,
                onThemeChanged: (value) {
                  ++_themeEpoch;
                  setState(() => _accountTheme = value);
                },
                onShowMessage: _showMessage,
                onAsk: _askFromVault,
                onDestinationSelected: (index) {
                  setState(() {
                    _selectedIndex = index;
                    _focusMessageId = null;
                  });
                },
                onLogOut: _logOut,
              )
            : _ConnectionPage(error: _connectionError, onConnect: _connect),
      ),
    );
  }
}

class _RestoringConnection extends StatelessWidget {
  const _RestoringConnection();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const NodPresence(state: NodMotionState.connecting, size: 72),
            const SizedBox(height: NodSpacing.lg),
            Text(
              'Reconnecting to Nod',
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ],
        ),
      ),
    );
  }
}

class _ConnectionPage extends StatefulWidget {
  const _ConnectionPage({required this.error, required this.onConnect});

  final String? error;
  final Future<void> Function(NodConnectionConfig config) onConnect;

  @override
  State<_ConnectionPage> createState() => _ConnectionPageState();
}

class _ConnectionPageState extends State<_ConnectionPage> {
  final _formKey = GlobalKey<FormState>();
  final _originController = TextEditingController();
  final _tokenController = TextEditingController();
  var _submitting = false;
  var _hideToken = true;

  @override
  void dispose() {
    _originController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || !_formKey.currentState!.validate()) return;
    NodConnectionConfig config;
    try {
      config = NodConnectionConfig(
        origin: validateNodOrigin(Uri.parse(_originController.text.trim())),
        token: _tokenController.text,
      );
    } on NodException {
      _formKey.currentState!.validate();
      return;
    }
    setState(() => _submitting = true);
    try {
      await widget.onConnect(config);
      _tokenController.clear();
    } on NodException {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.nodColors;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(NodSpacing.lg),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Align(
                      alignment: Alignment.centerLeft,
                      child: NodBrandMark(size: 56),
                    ),
                    const SizedBox(height: NodSpacing.lg),
                    Text(
                      'Connect this app to Nod',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: NodSpacing.sm),
                    Text(
                      'Enter the connection details provided by your Nod server. They stay on this device in secure storage.',
                      style: Theme.of(context).textTheme.bodyLarge
                          ?.copyWith(color: colors.textSecondary),
                    ),
                    const SizedBox(height: NodSpacing.xl),
                    TextFormField(
                      key: const Key('connection-origin'),
                      controller: _originController,
                      keyboardType: TextInputType.url,
                      textInputAction: TextInputAction.next,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        labelText: 'Nod server address',
                        hintText: 'https://nod.example.com',
                        helperText: 'Use the full HTTPS address.',
                      ),
                      validator: (value) {
                        try {
                          validateNodOrigin(Uri.parse(value?.trim() ?? ''));
                          return null;
                        } on NodException catch (error) {
                          return error.message;
                        }
                      },
                    ),
                    const SizedBox(height: NodSpacing.md),
                    TextFormField(
                      key: const Key('connection-token'),
                      controller: _tokenController,
                      obscureText: _hideToken,
                      enableSuggestions: false,
                      autocorrect: false,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'Access token',
                        helperText: 'Stored securely and never shown again.',
                        suffixIcon: IconButton(
                          tooltip: _hideToken ? 'Show token' : 'Hide token',
                          onPressed: () =>
                              setState(() => _hideToken = !_hideToken),
                          icon: Icon(
                            _hideToken
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                        ),
                      ),
                      validator: (value) => value == null || value.isEmpty
                          ? 'Enter the server token.'
                          : null,
                    ),
                    if (widget.error != null) ...[
                      const SizedBox(height: NodSpacing.md),
                      Semantics(
                        container: true,
                        liveRegion: true,
                        label: 'Connection error: ${widget.error!}',
                        excludeSemantics: true,
                        child: Container(
                          key: const Key('connection-error'),
                          padding: const EdgeInsets.all(NodSpacing.md),
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.errorContainer,
                            borderRadius: BorderRadius.circular(NodRadii.input),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(
                                Icons.error_outline_rounded,
                                color: Theme.of(context)
                                    .colorScheme
                                    .onErrorContainer,
                              ),
                              const SizedBox(width: NodSpacing.sm),
                              Expanded(
                                child: Text(
                                  widget.error!,
                                  style: Theme.of(context).textTheme.bodyMedium
                                      ?.copyWith(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onErrorContainer,
                                      ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: NodSpacing.lg),
                    FilledButton.icon(
                      key: const Key('connection-submit'),
                      onPressed: _submitting ? null : _submit,
                      icon: _submitting
                          ? const SizedBox.square(
                              dimension: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.link_rounded),
                      label: Text(
                        _submitting ? 'Connecting to Nod' : 'Connect to Nod',
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ConnectedShell extends StatelessWidget {
  const _ConnectedShell({
    required this.repository,
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.onLogOut,
    required this.onShowMessage,
    required this.onAsk,
    this.focusMessageId,
    required this.onThemeChanged,
  });

  final ValueChanged<ThemeMode> onThemeChanged;
  final String? focusMessageId;
  final ValueChanged<String> onShowMessage;
  final Future<void> Function(String text) onAsk;
  final NodRepository repository;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final Future<void> Function() onLogOut;

  @override
  Widget build(BuildContext context) {
    final transport = repository is NodApiTransport
        ? repository as NodApiTransport
        : null;
    final destinations = [
      ...NodNavigationModel.destinations,
      if (transport != null) ...[
        const NodNavigationDestination(
          label: 'Tasks',
          icon: Icons.task_outlined,
          selectedIcon: Icons.task,
        ),
        const NodNavigationDestination(
          label: 'Prepared',
          icon: Icons.drafts_outlined,
          selectedIcon: Icons.drafts,
        ),
        const NodNavigationDestination(
          label: 'Private entry',
          icon: Icons.lock_outline,
          selectedIcon: Icons.lock,
        ),
        const NodNavigationDestination(
          label: 'Settings',
          icon: Icons.settings_outlined,
          selectedIcon: Icons.settings,
        ),
        const NodNavigationDestination(
          label: 'Vault',
          icon: Icons.shield_outlined,
          selectedIcon: Icons.shield,
        ),
        const NodNavigationDestination(
          label: 'Notifications',
          icon: Icons.notifications_outlined,
          selectedIcon: Icons.notifications,
        ),
      ],
    ];
    void showMessage(String id) {
      Navigator.of(context).popUntil((route) => route.isFirst);
      onShowMessage(id);
    }

    void openPrivate() {
      if (transport == null) return;
      FocusManager.instance.primaryFocus?.unfocus();
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => NodPrivateRequestsPage(transport: transport),
        ),
      );
    }

    return NodAdaptiveShell(
      destinations: destinations,
      selectedIndex: selectedIndex,
      onDestinationSelected: (index) {
        FocusManager.instance.primaryFocus?.unfocus();
        onDestinationSelected(index);
      },
      onLogOut: onLogOut,
      actions: [
        if (selectedIndex == 0 && transport != null)
          IconButton(
            key: const Key('open-private-requests'),
            tooltip: 'Private entry and browser',
            onPressed: openPrivate,
            icon: const Icon(Icons.info_outline_rounded),
          ),
      ],
      body: IndexedStack(
        index: selectedIndex == 0 ? 0 : 1,
        children: [
          NodChat(
            repository: repository,
            active: selectedIndex == 0,
            focusMessageId: focusMessageId,
          ),
          selectedIndex == 1 && repository is NodSchedulesRepository
              ? NodScheduledPage(
                  repository: repository as NodSchedulesRepository,
                  onOpenChat: () => onDestinationSelected(0),
                )
              : selectedIndex == 3 && repository is NodUsageRepository
              ? NodUsagePage(repository: repository as NodUsageRepository)
              : selectedIndex == 2 && repository is NodAppsRepository
              ? Column(
                  children: [
                    if (transport != null)
                      ListTile(
                        leading: const Icon(Icons.manage_accounts_outlined),
                        title: const Text('Manage accounts and channels'),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) =>
                                NodConnectionsPage(transport: transport),
                          ),
                        ),
                      ),
                    Expanded(
                      child: NodAppsPage(
                        repository: repository as NodAppsRepository,
                      ),
                    ),
                  ],
                )
              : selectedIndex == 4 && transport != null
              ? NodTasksPage(transport: transport, onShowMessage: showMessage)
              : selectedIndex == 5 && transport != null
              ? NodPreparedPage(transport: transport)
              : selectedIndex == 6 && transport != null
              ? NodPrivateRequestsPage(transport: transport)
              : selectedIndex == 7 && transport != null
              ? NodSettingsPage(
                  transport: transport,
                  onThemeChanged: onThemeChanged,
                  onShowMessage: showMessage,
                )
              : selectedIndex == 8 && transport != null
              ? NodVaultPage(transport: transport, onAsk: onAsk)
              : selectedIndex == 9 && transport != null
              ? NodNotificationSettingsPage(transport: transport)
              : _SectionPlaceholder(destination: destinations[selectedIndex]),
        ],
      ),
    );
  }
}

class _SectionPlaceholder extends StatelessWidget {
  const _SectionPlaceholder({required this.destination});

  final NodNavigationDestination destination;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: context.nodColors.canvas,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(NodSpacing.lg),
          child: Text(
            '${destination.label} remains outside this client POC.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
      ),
    );
  }
}
