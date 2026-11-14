import 'package:flutter/material.dart';

import '../motion/nod_motion.dart';
import 'nod_brand_mark.dart';
import 'nod_tokens.dart';

@immutable
class NodNavigationDestination {
  const NodNavigationDestination({
    required this.label,
    required this.icon,
    required this.selectedIcon,
  });

  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

abstract final class NodNavigationModel {
  static const destinations = [
    NodNavigationDestination(
      label: 'Chat',
      icon: Icons.chat_bubble_outline_rounded,
      selectedIcon: Icons.chat_bubble_rounded,
    ),
    NodNavigationDestination(
      label: 'Scheduled',
      icon: Icons.calendar_today_outlined,
      selectedIcon: Icons.calendar_month_rounded,
    ),
    NodNavigationDestination(
      label: 'Apps',
      icon: Icons.grid_view_outlined,
      selectedIcon: Icons.grid_view_rounded,
    ),
    NodNavigationDestination(
      label: 'Usage',
      icon: Icons.speed_outlined,
      selectedIcon: Icons.speed_rounded,
    ),
  ];
}

class NodAdaptiveShell extends StatelessWidget {
  const NodAdaptiveShell({
    super.key,
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.body,
    this.destinations = NodNavigationModel.destinations,
    this.actions = const [],
    this.onLogOut,
  });

  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final Widget body;
  final List<NodNavigationDestination> destinations;
  final List<Widget> actions;
  final VoidCallback? onLogOut;

  @override
  Widget build(BuildContext context) {
    assert(selectedIndex >= 0 && selectedIndex < destinations.length);
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < NodBreakpoints.compact) {
          return _CompactShell(
            selectedIndex: selectedIndex,
            onDestinationSelected: onDestinationSelected,
            destinations: destinations,
            actions: actions,
            body: body,
            onLogOut: onLogOut,
          );
        }
        return _ExpandedShell(
          selectedIndex: selectedIndex,
          onDestinationSelected: onDestinationSelected,
          destinations: destinations,
          actions: actions,
          body: body,
          onLogOut: onLogOut,
        );
      },
    );
  }
}

class _CompactShell extends StatelessWidget {
  const _CompactShell({
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.destinations,
    required this.onLogOut,
    required this.actions,
    required this.body,
  });

  final VoidCallback? onLogOut;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final List<NodNavigationDestination> destinations;
  final List<Widget> actions;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    final isChat = selectedIndex == 0;
    return PopScope(
      canPop: isChat,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && !isChat) onDestinationSelected(0);
      },
      child: Scaffold(
        key: const Key('compact-shell'),
        appBar: AppBar(
          toolbarHeight: 64,
          titleSpacing: NodSpacing.xs,
          leading: isChat
              ? Builder(
                  builder: (context) => IconButton(
                    key: const Key('open-navigation'),
                    tooltip: 'Open menu',
                    icon: const Icon(Icons.menu_rounded),
                    onPressed: () {
                      FocusManager.instance.primaryFocus?.unfocus();
                      Scaffold.of(context).openDrawer();
                    },
                  ),
                )
              : IconButton(
                  key: const Key('back-to-chat'),
                  tooltip: 'Back to chat',
                  icon: const Icon(Icons.arrow_back_rounded),
                  onPressed: () => onDestinationSelected(0),
                ),
          title: isChat
              ? const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    NodBrandMark(size: 28),
                    SizedBox(width: NodSpacing.xs),
                    Text('Nod'),
                  ],
                )
              : Text(destinations[selectedIndex].label),
          actions: actions,
        ),
        drawer: Drawer(
          key: const Key('compact-navigation'),
          semanticLabel: 'Navigation menu',
          child: SafeArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 8, 16),
                  child: Row(
                    children: [
                      const NodBrandMark(size: 32),
                      const SizedBox(width: NodSpacing.sm),
                      Text(
                        'Nod',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const Spacer(),
                      Builder(
                        builder: (context) => IconButton(
                          tooltip: 'Close menu',
                          icon: const Icon(Icons.close_rounded),
                          onPressed: () => Scaffold.of(context).closeDrawer(),
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.symmetric(
                      horizontal: NodSpacing.sm,
                    ),
                    children: [
                      for (var index = 0; index < destinations.length; index++)
                        Builder(
                          builder: (context) => ListTile(
                            key: Key(
                              'mobile-navigation-${destinations[index].label.toLowerCase()}',
                            ),
                            selected: selectedIndex == index,
                            selectedTileColor: Theme.of(context)
                                .colorScheme
                                .secondaryContainer,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                NodRadii.control,
                              ),
                            ),
                            leading: Icon(
                              selectedIndex == index
                                  ? destinations[index].selectedIcon
                                  : destinations[index].icon,
                            ),
                            title: Text(destinations[index].label),
                            onTap: () {
                              Scaffold.of(context).closeDrawer();
                              FocusManager.instance.primaryFocus?.unfocus();
                              onDestinationSelected(index);
                            },
                          ),
                        ),
                      if (onLogOut != null) ...[
                        const Divider(),
                        Builder(
                          builder: (context) => ListTile(
                            key: const Key('log-out'),
                            leading: const Icon(Icons.logout_rounded),
                            title: const Text('Log out'),
                            onTap: () {
                              Scaffold.of(context).closeDrawer();
                              onLogOut!();
                            },
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        body: SafeArea(top: false, child: body),
      ),
    );
  }
}

class _ExpandedShell extends StatelessWidget {
  const _ExpandedShell({
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.destinations,
    required this.onLogOut,
    required this.actions,
    required this.body,
  });

  final VoidCallback? onLogOut;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final List<NodNavigationDestination> destinations;
  final List<Widget> actions;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('expanded-shell'),
      body: SafeArea(
        child: Row(
          children: [
            _DesktopSidebar(
              selectedIndex: selectedIndex,
              onDestinationSelected: onDestinationSelected,
              destinations: destinations,
              onLogOut: onLogOut,
            ),
            Expanded(
              child: Column(
                children: [
                  SizedBox(
                    height: 64,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border(
                          bottom: BorderSide(color: context.nodColors.border),
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: NodSpacing.lg,
                        ),
                        child: Row(
                          children: [
                            Text(
                              destinations[selectedIndex].label,
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            const Spacer(),
                            ...actions,
                          ],
                        ),
                      ),
                    ),
                  ),
                  Expanded(child: body),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DesktopSidebar extends StatelessWidget {
  const _DesktopSidebar({
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.destinations,
    required this.onLogOut,
  });

  final VoidCallback? onLogOut;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final List<NodNavigationDestination> destinations;

  @override
  Widget build(BuildContext context) {
    final colors = context.nodColors;
    return Container(
      key: const Key('desktop-sidebar'),
      width: NodSizes.sidebar,
      color: colors.sidebar,
      padding: const EdgeInsets.fromLTRB(
        NodSpacing.sm,
        NodSpacing.lg,
        NodSpacing.sm,
        NodSpacing.sm,
      ),
      child: FocusTraversalGroup(
        policy: OrderedTraversalPolicy(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: NodSpacing.sm),
              child: Row(
                children: [
                  NodBrandMark(size: 44),
                  SizedBox(width: NodSpacing.xs),
                  Flexible(
                    child: Text(
                      'Nod',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: NodSpacing.xl),
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  for (var index = 0; index < destinations.length; index++) ...[
                    FocusTraversalOrder(
                      order: NumericFocusOrder(index.toDouble()),
                      child: _DesktopNavigationItem(
                        destination: destinations[index],
                        selected: selectedIndex == index,
                        onTap: () => onDestinationSelected(index),
                      ),
                    ),
                    if (index != destinations.length - 1)
                      const SizedBox(height: NodSpacing.xxs),
                  ],
                ],
              ),
            ),
            if (onLogOut != null) ...[
              const Divider(),
              Material(
                color: Colors.transparent,
                child: ListTile(
                  key: const Key('log-out'),
                  leading: const Icon(Icons.logout_rounded),
                  title: const Text('Log out'),
                  onTap: onLogOut,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _DesktopNavigationItem extends StatefulWidget {
  const _DesktopNavigationItem({
    required this.destination,
    required this.selected,
    required this.onTap,
  });

  final NodNavigationDestination destination;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_DesktopNavigationItem> createState() => _DesktopNavigationItemState();
}

class _DesktopNavigationItemState extends State<_DesktopNavigationItem> {
  var _focused = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.nodColors;
    final duration = NodMotion.duration(
      context,
      widget.selected ? NodMotionDurations.state : NodMotionDurations.feedback,
    );
    return Semantics(
      selected: widget.selected,
      button: true,
      child: AnimatedContainer(
        duration: duration,
        curve: NodMotionCurves.enter,
        decoration: BoxDecoration(
          color: widget.selected ? colors.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(NodRadii.full),
          border: _focused
              ? Border.all(color: colors.focusRing, width: 2)
              : Border.all(color: Colors.transparent, width: 2),
        ),
        child: InkWell(
          key: Key(
            'desktop-navigation-${widget.destination.label.toLowerCase()}',
          ),
          borderRadius: BorderRadius.circular(NodRadii.full),
          mouseCursor: SystemMouseCursors.click,
          onFocusChange: (value) => setState(() => _focused = value),
          onTap: widget.onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: NodSizes.touchTarget),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: NodSpacing.md),
              child: Row(
                children: [
                  Icon(
                    widget.selected
                        ? widget.destination.selectedIcon
                        : widget.destination.icon,
                    color: widget.selected
                        ? colors.accent
                        : colors.mutedForeground,
                    size: 24,
                  ),
                  const SizedBox(width: NodSpacing.sm),
                  Expanded(
                    child: Text(
                      widget.destination.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: widget.selected
                            ? Theme.of(context).colorScheme.onSurface
                            : colors.mutedForeground,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
