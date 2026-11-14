import 'package:flutter/material.dart';

import 'nod_tokens.dart';

class NodBrandMark extends StatelessWidget {
  const NodBrandMark({
    super.key,
    this.size = 32,
    this.color,
    this.semanticLabel = 'Nod',
  });

  final double size;
  final Color? color;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: semanticLabel,
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: size,
          child: CustomPaint(
            painter: _NodBrandPainter(
              color: color ?? Theme.of(context).colorScheme.onSurface,
            ),
          ),
        ),
      ),
    );
  }
}

class _NodBrandPainter extends CustomPainter {
  const _NodBrandPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.shortestSide / 32;
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4 * scale
      ..strokeCap = StrokeCap.round
      ..color = color;
    final dot = Paint()..color = NodPalette.brandPink;
    canvas.drawCircle(Offset(16 * scale, 16 * scale), 10 * scale, ring);
    canvas.drawCircle(Offset(25 * scale, 6 * scale), 4 * scale, dot);
  }

  @override
  bool shouldRepaint(_NodBrandPainter oldDelegate) =>
      oldDelegate.color != color;
}
