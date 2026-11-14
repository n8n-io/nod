import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../design_system/nod_tokens.dart';
import 'nod_motion.dart';
import 'nod_motion_state.dart';

extension NodMotionStateLabel on NodMotionState {
  String get label => switch (this) {
    NodMotionState.idle => 'Idle',
    NodMotionState.connecting => 'Connecting',
    NodMotionState.working => 'Working',
    NodMotionState.waiting => 'Waiting',
    NodMotionState.success => 'Complete',
    NodMotionState.error => 'Error',
    NodMotionState.offline => 'Offline',
  };

  String get semanticLabel => switch (this) {
    NodMotionState.idle => 'Nod is idle',
    NodMotionState.connecting => 'Nod is connecting',
    NodMotionState.working => 'Nod is working',
    NodMotionState.waiting => 'Nod is waiting for you',
    NodMotionState.success => 'Nod finished successfully',
    NodMotionState.error => 'Nod encountered an error',
    NodMotionState.offline => 'Nod is offline',
  };
}

class NodPresence extends StatefulWidget {
  const NodPresence({
    super.key,
    required this.state,
    this.size = 72,
    this.semanticLabel,
  });

  final NodMotionState state;
  final double size;
  final String? semanticLabel;

  @override
  State<NodPresence> createState() => _NodPresenceState();
}

class _NodPresenceState extends State<NodPresence>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  var _reducedMotion = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: NodMotionDurations.state,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reducedMotion = NodMotion.reduced(context);
    if (reducedMotion == _reducedMotion && _controller.isAnimating) return;
    _reducedMotion = reducedMotion;
    _configureAnimation();
  }

  @override
  void didUpdateWidget(NodPresence oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state != widget.state) _configureAnimation();
  }

  void _configureAnimation() {
    _controller.stop();
    if (_reducedMotion) {
      _controller.value = 1;
      return;
    }
    switch (widget.state) {
      case NodMotionState.connecting:
        _controller.repeat(period: const Duration(milliseconds: 1100));
        break;
      case NodMotionState.working:
        _controller.repeat(period: const Duration(milliseconds: 1200));
        break;
      case NodMotionState.waiting:
        _controller.repeat(period: const Duration(milliseconds: 2400));
        break;
      case NodMotionState.success:
        _controller.duration = NodMotionDurations.focalExit;
        _controller.forward(from: 0);
        break;
      case NodMotionState.error:
        _controller.duration = NodMotionDurations.layoutExit;
        _controller.forward(from: 0);
        break;
      case NodMotionState.idle:
      case NodMotionState.offline:
        _controller.value = 1;
        break;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.nodColors;
    final colorScheme = Theme.of(context).colorScheme;
    return Semantics(
      key: const Key('nod-presence'),
      image: true,
      liveRegion: widget.state != NodMotionState.idle,
      label: widget.semanticLabel ?? widget.state.semanticLabel,
      child: ExcludeSemantics(
        child: RepaintBoundary(
          child: SizedBox.square(
            dimension: widget.size,
            child: CustomPaint(
              painter: _NodPresencePainter(
                state: widget.state,
                progress: _controller,
                foreground: colorScheme.onSurface,
                muted: colors.mutedForeground,
                border: colors.border,
                success: colors.success,
                error: colorScheme.error,
                reducedMotion: _reducedMotion,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _NodPresencePainter extends CustomPainter {
  _NodPresencePainter({
    required this.state,
    required this.progress,
    required this.foreground,
    required this.muted,
    required this.border,
    required this.success,
    required this.error,
    required this.reducedMotion,
  }) : super(repaint: progress);

  final NodMotionState state;
  final Animation<double> progress;
  final Color foreground;
  final Color muted;
  final Color border;
  final Color success;
  final Color error;
  final bool reducedMotion;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.shortestSide / 32;
    final center = Offset(16 * scale, 16 * scale);
    final radius = 10 * scale;
    final stroke = 4 * scale;
    final value = progress.value;
    var ringColor = foreground;
    var dotColor = NodPalette.brandPink;
    var dotOpacity = 1.0;
    var dotScale = 1.0;
    var angle = -math.pi / 4;
    var dotOffset = Offset.zero;

    switch (state) {
      case NodMotionState.idle:
        break;
      case NodMotionState.connecting:
        ringColor = border;
        angle = -math.pi / 4 + (math.pi * 2 * value);
        break;
      case NodMotionState.working:
        angle = -math.pi / 4 + (math.pi * 2 * value);
        dotScale = reducedMotion ? 1 : 1 + 0.16 * math.sin(math.pi * 2 * value);
        break;
      case NodMotionState.waiting:
        dotOpacity = reducedMotion
            ? 0.55
            : 0.35 + 0.65 * ((math.sin(math.pi * 2 * value) + 1) / 2);
        break;
      case NodMotionState.success:
        ringColor = success;
        dotColor = success;
        if (!reducedMotion) {
          final eased = NodMotionCurves.enter.transform(value);
          dotOffset = Offset(0, -3.5 * scale * math.sin(math.pi * eased));
          dotScale = 1 + 0.2 * math.sin(math.pi * eased);
        }
        break;
      case NodMotionState.error:
        ringColor = error;
        dotColor = error;
        if (!reducedMotion) {
          final eased = NodMotionCurves.reveal.transform(value);
          dotOffset = Offset(0, 2.5 * scale * math.sin(math.pi * eased));
          dotScale = 1 - 0.15 * math.sin(math.pi * eased);
        }
        break;
      case NodMotionState.offline:
        ringColor = muted;
        dotColor = muted;
        dotOpacity = 0.55;
        break;
    }

    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..color = ringColor;
    canvas.drawCircle(center, radius, ring);

    if (state == NodMotionState.connecting) {
      final arc = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.round
        ..color = NodPalette.brandPink;
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        angle - math.pi / 4,
        math.pi / 2,
        false,
        arc,
      );
    }

    if (state == NodMotionState.working && !reducedMotion) {
      final trail = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5 * scale
        ..strokeCap = StrokeCap.round
        ..color = NodPalette.brandPink.withValues(alpha: 0.7);
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius + 4 * scale),
        angle - math.pi / 2,
        math.pi * 0.72,
        false,
        trail,
      );
    }

    final orbitRadius = math.sqrt(181) * scale;
    final orbiting =
        state == NodMotionState.connecting || state == NodMotionState.working;
    final dotCenter = orbiting && !reducedMotion
        ? center + Offset(math.cos(angle), math.sin(angle)) * orbitRadius
        : Offset(25 * scale, 6 * scale);
    final dot = Paint()..color = dotColor.withValues(alpha: dotOpacity);
    canvas.drawCircle(dotCenter + dotOffset, 4 * scale * dotScale, dot);

    if (state == NodMotionState.offline) {
      final slash = Paint()
        ..color = ThemeData.estimateBrightnessForColor(muted) == Brightness.dark
            ? NodPalette.white
            : NodPalette.black
        ..strokeWidth = 1.8 * scale
        ..strokeCap = StrokeCap.round;
      canvas.drawLine(
        center + Offset(-5 * scale, 5 * scale),
        center + Offset(5 * scale, -5 * scale),
        slash,
      );
    }
  }

  @override
  bool shouldRepaint(_NodPresencePainter oldDelegate) =>
      oldDelegate.state != state ||
      oldDelegate.foreground != foreground ||
      oldDelegate.muted != muted ||
      oldDelegate.border != border ||
      oldDelegate.success != success ||
      oldDelegate.error != error ||
      oldDelegate.reducedMotion != reducedMotion;
}
