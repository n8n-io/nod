import 'package:flutter/material.dart';

import '../design_system/design_system.dart';
import '../motion/motion.dart';

class NodApp extends StatelessWidget {
  const NodApp({
    super.key,
    this.themeMode = ThemeMode.system,
    this.initialDestination = 0,
  });

  final ThemeMode themeMode;
  final int initialDestination;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nod',
      debugShowCheckedModeBanner: false,
      theme: NodTheme.light,
      darkTheme: NodTheme.dark,
      themeMode: themeMode,
      home: NodMotionLifecycle(
        child: _NodShellPreview(initialDestination: initialDestination),
      ),
    );
  }
}

class _NodShellPreview extends StatefulWidget {
  const _NodShellPreview({required this.initialDestination});

  final int initialDestination;

  @override
  State<_NodShellPreview> createState() => _NodShellPreviewState();
}

class _NodShellPreviewState extends State<_NodShellPreview> {
  late var _selectedIndex = widget.initialDestination;
  var _presenceState = NodMotionState.idle;

  @override
  Widget build(BuildContext context) {
    return NodAdaptiveShell(
      selectedIndex: _selectedIndex,
      onDestinationSelected: (index) => setState(() => _selectedIndex = index),
      body: _PreviewPage(
        key: ValueKey(_selectedIndex),
        destination: NodNavigationModel.destinations[_selectedIndex],
        index: _selectedIndex,
        presenceState: _presenceState,
        onPresenceStateChanged: (state) =>
            setState(() => _presenceState = state),
      ),
    );
  }
}

class _PreviewPage extends StatelessWidget {
  const _PreviewPage({
    super.key,
    required this.destination,
    required this.index,
    required this.presenceState,
    required this.onPresenceStateChanged,
  });

  final NodNavigationDestination destination;
  final int index;
  final NodMotionState presenceState;
  final ValueChanged<NodMotionState> onPresenceStateChanged;

  @override
  Widget build(BuildContext context) {
    final content = switch (index) {
      0 => const (
        title: 'What can I help with?',
        description: 'A quiet, adaptive shell for conversations and work that continues across your devices.',
      ),
      1 => const (
        title: 'Scheduled work',
        description: 'Recurring and one-time work will share this focused native layout.',
      ),
      2 => const (
        title: 'Connected apps',
        description: 'Connections stay server-owned while the client presents clear status and controls.',
      ),
      _ => const (
        title: 'Usage',
        description: 'Spending and activity will remain legible at phone and desktop sizes.',
      ),
    };
    return ColoredBox(
      color: context.nodColors.canvas,
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(
          horizontal: NodSpacing.lg,
          vertical: NodSpacing.xl,
        ),
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  content.title,
                  style: Theme.of(context).textTheme.displaySmall,
                ),
                const SizedBox(height: NodSpacing.sm),
                Text(
                  content.description,
                  style: Theme.of(context).textTheme.bodyLarge
                      ?.copyWith(color: context.nodColors.textSecondary),
                ),
                const SizedBox(height: NodSpacing.xxl),
                if (index == 0)
                  _PresencePreview(
                    state: presenceState,
                    onChanged: onPresenceStateChanged,
                  )
                else
                  _DestinationPlaceholder(destination: destination),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PresencePreview extends StatelessWidget {
  const _PresencePreview({required this.state, required this.onChanged});

  final NodMotionState state;
  final ValueChanged<NodMotionState> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(
            horizontal: NodSpacing.lg,
            vertical: NodSpacing.xxl,
          ),
          decoration: BoxDecoration(
            color: context.nodColors.surfaceOverlay,
            border: Border.all(color: context.nodColors.border),
            borderRadius: BorderRadius.circular(NodRadii.dialog),
            boxShadow: NodElevation.composer(Theme.of(context).brightness),
          ),
          child: Column(
            children: [
              NodPresence(state: state, size: 88),
              const SizedBox(height: NodSpacing.lg),
              Text(state.label, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: NodSpacing.xs),
              Text(
                _stateDescription(state),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium
                    ?.copyWith(color: context.nodColors.mutedForeground),
              ),
            ],
          ),
        ),
        const SizedBox(height: NodSpacing.lg),
        Text('Presence', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: NodSpacing.sm),
        Wrap(
          spacing: NodSpacing.xs,
          runSpacing: NodSpacing.xs,
          children: [
            for (final option in NodMotionState.values)
              ChoiceChip(
                key: Key('presence-${option.name}'),
                label: Text(option.label),
                selected: state == option,
                onSelected: (_) => onChanged(option),
              ),
          ],
        ),
      ],
    );
  }

  String _stateDescription(NodMotionState state) => switch (state) {
    NodMotionState.idle => 'Ready for the next request.',
    NodMotionState.connecting => 'Establishing a secure connection.',
    NodMotionState.working => 'Making progress on the current request.',
    NodMotionState.waiting => 'Waiting for your decision.',
    NodMotionState.success => 'The requested work is complete.',
    NodMotionState.error => 'Something needs attention before continuing.',
    NodMotionState.offline => 'The server is currently unavailable.',
  };
}

class _DestinationPlaceholder extends StatelessWidget {
  const _DestinationPlaceholder({required this.destination});

  final NodNavigationDestination destination;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: NodSpacing.xxl),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: context.nodColors.border),
          bottom: BorderSide(color: context.nodColors.border),
        ),
      ),
      child: Row(
        children: [
          Icon(
            destination.selectedIcon,
            size: 28,
            color: context.nodColors.accent,
          ),
          const SizedBox(width: NodSpacing.md),
          Expanded(
            child: Text(
              '${destination.label} will use the same adaptive shell.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
          ),
        ],
      ),
    );
  }
}
