import 'package:flutter/material.dart';
import 'package:rive/rive.dart';

import 'nod_motion.dart';
import 'nod_motion_state.dart';
import 'nod_presence.dart';

typedef NodRiveStateBinder = void Function(
  NodMotionState state,
  RiveWidgetController controller,
  bool animate,
);

class NodRivePresenceAdapter extends StatefulWidget {
  const NodRivePresenceAdapter({
    super.key,
    required this.state,
    required this.fileLoader,
    required this.stateMachineName,
    required this.bindState,
    this.size = 72,
    this.fallback,
  });

  final NodMotionState state;
  final FileLoader fileLoader;
  final String stateMachineName;
  final NodRiveStateBinder bindState;
  final double size;
  final Widget? fallback;

  @override
  State<NodRivePresenceAdapter> createState() => _NodRivePresenceAdapterState();
}

class _NodRivePresenceAdapterState extends State<NodRivePresenceAdapter> {
  RiveWidgetController? _controller;
  var _animate = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animate =
        !NodMotion.reduced(context) && TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didUpdateWidget(NodRivePresenceAdapter oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state != widget.state) _sync();
  }

  void _sync() {
    final controller = _controller;
    if (controller == null) return;
    controller.active = _animate;
    widget.bindState(widget.state, controller, _animate);
  }

  Widget _fallback() =>
      widget.fallback ?? NodPresence(state: widget.state, size: widget.size);

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      liveRegion: widget.state != NodMotionState.idle,
      label: widget.state.semanticLabel,
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: widget.size,
          child: RiveWidgetBuilder(
            fileLoader: widget.fileLoader,
            stateMachineSelector: StateMachineSelector.byName(
              widget.stateMachineName,
            ),
            onLoaded: (loaded) {
              _controller = loaded.controller;
              _sync();
            },
            onFailed: (_, _) => _controller = null,
            builder: (context, state) => switch (state) {
              RiveLoaded(:final controller) => RiveWidget(
                controller: controller,
              ),
              RiveLoading() || RiveFailed() => _fallback(),
            },
          ),
        ),
      ),
    );
  }
}
