import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../design_system/nod_brand_mark.dart';
import '../design_system/nod_tokens.dart';
import 'nod_motion.dart';

class NodAmbientWaves extends StatefulWidget {
  const NodAmbientWaves({
    super.key,
    required this.visible,
    required this.working,
    this.active = true,
  });

  final bool visible;
  final bool working;
  final bool active;

  @override
  State<NodAmbientWaves> createState() => _NodAmbientWavesState();
}

class _NodAmbientWavesState extends State<NodAmbientWaves>
    with TickerProviderStateMixin {
  late final AnimationController _phase;
  late final AnimationController _reveal;
  late final AnimationController _energy;
  late final Listenable _repaint;
  var _reduced = false;
  var _ticking = true;
  var _contrast = false;

  @override
  void initState() {
    super.initState();
    _phase = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 8),
    );
    _reveal =
        AnimationController(
          vsync: this,
          duration: NodMotionDurations.focal,
          reverseDuration: NodMotionDurations.focalExit,
        )..addStatusListener((status) {
          if (status == AnimationStatus.dismissed) _phase.stop();
        });
    _energy = AnimationController(
      vsync: this,
      duration: NodMotionDurations.focal,
      value: widget.working ? 1 : 0,
    );
    _repaint = Listenable.merge([_phase, _reveal, _energy]);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = NodMotion.reduced(context);
    _ticking = TickerMode.valuesOf(context).enabled;
    _contrast = MediaQuery.highContrastOf(context);
    _configure();
  }

  @override
  void didUpdateWidget(NodAmbientWaves oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.visible != widget.visible ||
        oldWidget.working != widget.working ||
        oldWidget.active != widget.active) {
      _configure();
    }
  }

  void _configure() {
    final visible = widget.visible && widget.active && !_contrast;
    if (_reduced || !_ticking || !widget.active) {
      _phase.stop();
      _energy.stop();
      _reveal.stop();
      _phase.value = 0;
      _energy.value = widget.working ? 1 : 0;
      _reveal.value = visible ? 1 : 0;
      return;
    }
    _energy.animateTo(widget.working ? 1 : 0, curve: NodMotionCurves.enter);
    if (visible) {
      _reveal.forward();
      if (widget.working) {
        _phase.repeat(period: const Duration(seconds: 8));
      } else {
        _phase.forward();
      }
    } else {
      _reveal.reverse();
      if (_reveal.isDismissed) _phase.stop();
    }
  }

  @override
  void dispose() {
    _phase.dispose();
    _reveal.dispose();
    _energy.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Stack(
        fit: StackFit.expand,
        children: [
          ExcludeSemantics(
            child: RepaintBoundary(
              child: CustomPaint(
                painter: _AmbientPainter(
                  phase: _phase,
                  reveal: _reveal,
                  energy: _energy,
                  repaint: _repaint,
                  dark: Theme.of(context).brightness == Brightness.dark,
                ),
              ),
            ),
          ),
          if (widget.visible && widget.working && widget.active)
            Align(
              alignment: Alignment.bottomCenter,
              child: Padding(
                padding: const EdgeInsets.only(bottom: NodSpacing.md),
                child: Semantics(
                  key: const Key('chat-wave-progress'),
                  liveRegion: true,
                  label: 'Nod is working',
                  excludeSemantics: true,
                  child: RepaintBoundary(
                    child: RotationTransition(
                      turns: Tween<double>(begin: 0, end: 6).animate(_phase),
                      child: const NodBrandMark(size: 24),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AmbientPainter extends CustomPainter {
  _AmbientPainter({
    required this.phase,
    required this.reveal,
    required this.energy,
    required Listenable repaint,
    required this.dark,
  }) : super(repaint: repaint);

  final Animation<double> phase;
  final Animation<double> reveal;
  final Animation<double> energy;
  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    if (reveal.value == 0 || size.isEmpty) return;
    final intensity = reveal.value * (0.45 + energy.value * 0.55);
    final depth = math.min(size.height * 0.38, 230.0);
    final angle = phase.value * math.pi * 2;
    final bottom = Rect.fromLTWH(0, size.height - depth, size.width, depth);
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    final wash = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          NodPalette.brandPink.withValues(alpha: 0),
          NodPalette.brandPink.withValues(
            alpha: intensity * (dark ? 0.13 : 0.09),
          ),
        ],
      ).createShader(bottom);
    canvas.drawRect(bottom, wash);
    for (var layer = 0; layer < 6; layer++) {
      final path = Path();
      final base = size.height - 12 - layer * 9;
      for (var step = 0; step <= 96; step++) {
        final x = size.width * step / 96;
        final u = step / 96;
        final envelope = 0.3 + 0.7 * math.pow(math.sin(u * math.pi), 2);
        final swell = math.sin(u * math.pi * 2 + angle + layer * 0.47);
        final overtone = math.sin(u * math.pi * 3 - angle + layer * 0.31);
        final amplitude = (12 + energy.value * 19) * envelope;
        final y = base - amplitude * (1 + swell * 0.65 + overtone * 0.3);
        if (step == 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }
      final ink = layer.isEven ? NodPalette.brandPink : NodPalette.pink70;
      final ribbon = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = layer == 0 ? 1.8 : 0.9
        ..shader = LinearGradient(
          colors: [
            ink.withValues(alpha: intensity * 0.06),
            ink.withValues(alpha: intensity * (dark ? 0.6 : 0.36)),
            NodPalette.brandPink.withValues(alpha: intensity * 0.7),
            ink.withValues(alpha: intensity * 0.08),
          ],
          stops: const [0, 0.3, 0.7, 1],
        ).createShader(bottom);
      canvas.drawPath(path, ribbon);
      path
        ..lineTo(size.width, size.height)
        ..lineTo(0, size.height)
        ..close();
      canvas.drawPath(
        path,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              NodPalette.brandPink.withValues(alpha: 0),
              NodPalette.brandPink.withValues(alpha: intensity * 0.025),
            ],
          ).createShader(bottom),
      );
    }
    for (final right in [false, true]) {
      for (var layer = 0; layer < 3; layer++) {
        final side = Path();
        final edge = right ? size.width : 0.0;
        final direction = right ? -1.0 : 1.0;
        final drift = math.sin(angle + layer * 0.6) * (4 + energy.value * 5);
        side.moveTo(edge + direction * (3 + layer * 4), size.height + 8);
        side.cubicTo(
          edge + direction * (42 + drift + layer * 5),
          size.height - depth * 0.24,
          edge + direction * (4 + drift),
          size.height - depth * 0.68,
          edge - direction * 10,
          size.height - depth * (1.1 + layer * 0.1),
        );
        canvas.drawPath(
          side,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.2
            ..shader =
                LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    NodPalette.brandPink.withValues(alpha: 0),
                    NodPalette.brandPink.withValues(alpha: intensity * 0.48),
                  ],
                ).createShader(
                  Rect.fromLTWH(
                    0,
                    size.height - depth * 1.3,
                    size.width,
                    depth * 1.3,
                  ),
                ),
        );
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_AmbientPainter oldDelegate) => oldDelegate.dark != dark;
}
