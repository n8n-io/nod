import 'package:flutter/material.dart';

class NodMotionLifecycle extends StatefulWidget {
  const NodMotionLifecycle({super.key, required this.child});

  final Widget child;

  @override
  State<NodMotionLifecycle> createState() => _NodMotionLifecycleState();
}

class _NodMotionLifecycleState extends State<NodMotionLifecycle> {
  late final AppLifecycleListener _listener;
  var _active = true;

  @override
  void initState() {
    super.initState();
    _active = _isActive(WidgetsBinding.instance.lifecycleState);
    _listener = AppLifecycleListener(onStateChange: _handleStateChange);
  }

  bool _isActive(AppLifecycleState? state) =>
      state == null ||
      state == AppLifecycleState.resumed ||
      state == AppLifecycleState.inactive;

  void _handleStateChange(AppLifecycleState state) {
    final active = _isActive(state);
    if (active == _active || !mounted) return;
    setState(() => _active = active);
  }

  @override
  void dispose() {
    _listener.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TickerMode(
      key: const Key('nod-motion-ticker-mode'),
      enabled: _active,
      child: widget.child,
    );
  }
}
