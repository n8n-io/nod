import 'package:flutter/material.dart';

abstract final class NodMotionDurations {
  static const feedback = Duration(milliseconds: 120);
  static const feedbackExit = Duration(milliseconds: 100);
  static const state = Duration(milliseconds: 220);
  static const stateExit = Duration(milliseconds: 160);
  static const layout = Duration(milliseconds: 360);
  static const layoutExit = Duration(milliseconds: 280);
  static const focal = Duration(milliseconds: 640);
  static const focalExit = Duration(milliseconds: 480);
}

abstract final class NodMotionCurves {
  static const enter = Cubic(0.23, 1, 0.32, 1);
  static const reveal = Cubic(0.2, 0.8, 0.2, 1);
  static const travel = Cubic(0.65, 0, 0.35, 1);
}

abstract final class NodMotion {
  static bool reduced(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  static Duration duration(BuildContext context, Duration duration) =>
      reduced(context) ? Duration.zero : duration;
}
