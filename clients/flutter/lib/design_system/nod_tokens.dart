import 'package:flutter/material.dart';

abstract final class NodPalette {
  static const white = Color(0xFFFAFAFA);
  static const black = Color(0xFF191919);
  static const gray0 = Color(0xFFFFFFFF);
  static const gray10 = Color(0xFFF8F8F8);
  static const gray15 = Color(0xFFF1F1F1);
  static const gray20 = Color(0xFFEAEAEA);
  static const gray25 = Color(0xFFE0E0E0);
  static const gray30 = Color(0xFFD6D6D6);
  static const gray40 = Color(0xFFBFBFBF);
  static const gray50 = Color(0xFFA4A4A4);
  static const gray60 = Color(0xFF868686);
  static const gray70 = Color(0xFF676767);
  static const gray80 = Color(0xFF464646);
  static const gray85 = Color(0xFF353535);
  static const gray90 = Color(0xFF242424);
  static const pink10 = Color(0xFFFFE8EC);
  static const pink20 = Color(0xFFFFD0D9);
  static const pink30 = Color(0xFFFFBCCA);
  static const brandPink = Color(0xFFFF91AC);
  static const pink70 = Color(0xFF87003C);
  static const pink80 = Color(0xFF5A0026);
}

abstract final class NodTypography {
  static const display = 32.0;
  static const headline = 28.0;
  static const title = 24.0;
  static const titleSmall = 20.0;
  static const body = 16.0;
  static const control = 14.0;
  static const displayTracking = -1.0;
  static const headlineTracking = -0.8;
  static const titleTracking = -0.3;
}

abstract final class NodSpacing {
  static const xxs = 4.0;
  static const xs = 8.0;
  static const sm = 12.0;
  static const md = 16.0;
  static const lg = 24.0;
  static const xl = 32.0;
  static const xxl = 48.0;
  static const xxxl = 64.0;
}

abstract final class NodRadii {
  static const control = 8.0;
  static const input = 12.0;
  static const card = 12.0;
  static const dialog = 16.0;
  static const full = 400.0;
}

abstract final class NodBreakpoints {
  static const compact = 720.0;
  static const wide = 1184.0;
}

abstract final class NodSizes {
  static const control = 40.0;
  static const touchTarget = 48.0;
  static const sidebar = 224.0;
  static const content = 880.0;
}

abstract final class NodElevation {
  static List<BoxShadow> small(Brightness brightness) => [
    BoxShadow(
      color: brightness == Brightness.dark
          ? const Color(0x26000000)
          : const Color(0x0A000000),
      offset: const Offset(0, 1),
      blurRadius: 3,
    ),
  ];

  static List<BoxShadow> composer(Brightness brightness) => [
    BoxShadow(
      color: brightness == Brightness.dark
          ? const Color(0x26000000)
          : const Color(0x0F000000),
      offset: const Offset(0, 6),
      blurRadius: brightness == Brightness.dark ? 16 : 24,
    ),
    ...small(brightness),
  ];
}

@immutable
class NodColors extends ThemeExtension<NodColors> {
  const NodColors({
    required this.canvas,
    required this.sidebar,
    required this.surfaceOverlay,
    required this.surfaceSubtle,
    required this.surfaceInset,
    required this.textSecondary,
    required this.mutedForeground,
    required this.accent,
    required this.accentSoft,
    required this.accentBorder,
    required this.border,
    required this.focusRing,
    required this.success,
    required this.successSoft,
    required this.warning,
    required this.warningSoft,
    required this.info,
    required this.infoSoft,
  });

  final Color canvas;
  final Color sidebar;
  final Color surfaceOverlay;
  final Color surfaceSubtle;
  final Color surfaceInset;
  final Color textSecondary;
  final Color mutedForeground;
  final Color accent;
  final Color accentSoft;
  final Color accentBorder;
  final Color border;
  final Color focusRing;
  final Color success;
  final Color successSoft;
  final Color warning;
  final Color warningSoft;
  final Color info;
  final Color infoSoft;

  static const light = NodColors(
    canvas: NodPalette.white,
    sidebar: Color(0xFFF5F5F5),
    surfaceOverlay: NodPalette.gray0,
    surfaceSubtle: NodPalette.gray15,
    surfaceInset: NodPalette.gray20,
    textSecondary: NodPalette.gray80,
    mutedForeground: NodPalette.gray70,
    accent: NodPalette.pink70,
    accentSoft: NodPalette.pink10,
    accentBorder: NodPalette.pink30,
    border: NodPalette.gray25,
    focusRing: NodPalette.pink70,
    success: Color(0xFF276346),
    successSoft: Color(0xFFEAF5EE),
    warning: Color(0xFF82551C),
    warningSoft: Color(0xFFFBF1DF),
    info: Color(0xFF6551A5),
    infoSoft: Color(0xFFF0EDF9),
  );

  static const dark = NodColors(
    canvas: NodPalette.black,
    sidebar: Color(0xFF1F1F1F),
    surfaceOverlay: NodPalette.gray85,
    surfaceSubtle: NodPalette.gray90,
    surfaceInset: NodPalette.gray85,
    textSecondary: NodPalette.gray30,
    mutedForeground: NodPalette.gray40,
    accent: NodPalette.brandPink,
    accentSoft: NodPalette.pink80,
    accentBorder: NodPalette.pink70,
    border: NodPalette.gray85,
    focusRing: NodPalette.brandPink,
    success: Color(0xFF96D6B0),
    successSoft: Color(0xFF23372D),
    warning: Color(0xFFE8C38E),
    warningSoft: Color(0xFF3A3023),
    info: Color(0xFFC5B5F5),
    infoSoft: Color(0xFF312B42),
  );

  @override
  NodColors copyWith({
    Color? canvas,
    Color? sidebar,
    Color? surfaceOverlay,
    Color? surfaceSubtle,
    Color? surfaceInset,
    Color? textSecondary,
    Color? mutedForeground,
    Color? accent,
    Color? accentSoft,
    Color? accentBorder,
    Color? border,
    Color? focusRing,
    Color? success,
    Color? successSoft,
    Color? warning,
    Color? warningSoft,
    Color? info,
    Color? infoSoft,
  }) {
    return NodColors(
      canvas: canvas ?? this.canvas,
      sidebar: sidebar ?? this.sidebar,
      surfaceOverlay: surfaceOverlay ?? this.surfaceOverlay,
      surfaceSubtle: surfaceSubtle ?? this.surfaceSubtle,
      surfaceInset: surfaceInset ?? this.surfaceInset,
      textSecondary: textSecondary ?? this.textSecondary,
      mutedForeground: mutedForeground ?? this.mutedForeground,
      accent: accent ?? this.accent,
      accentSoft: accentSoft ?? this.accentSoft,
      accentBorder: accentBorder ?? this.accentBorder,
      border: border ?? this.border,
      focusRing: focusRing ?? this.focusRing,
      success: success ?? this.success,
      successSoft: successSoft ?? this.successSoft,
      warning: warning ?? this.warning,
      warningSoft: warningSoft ?? this.warningSoft,
      info: info ?? this.info,
      infoSoft: infoSoft ?? this.infoSoft,
    );
  }

  @override
  NodColors lerp(NodColors? other, double t) {
    if (other == null) return this;
    return NodColors(
      canvas: Color.lerp(canvas, other.canvas, t)!,
      sidebar: Color.lerp(sidebar, other.sidebar, t)!,
      surfaceOverlay: Color.lerp(surfaceOverlay, other.surfaceOverlay, t)!,
      surfaceSubtle: Color.lerp(surfaceSubtle, other.surfaceSubtle, t)!,
      surfaceInset: Color.lerp(surfaceInset, other.surfaceInset, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      mutedForeground: Color.lerp(mutedForeground, other.mutedForeground, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentSoft: Color.lerp(accentSoft, other.accentSoft, t)!,
      accentBorder: Color.lerp(accentBorder, other.accentBorder, t)!,
      border: Color.lerp(border, other.border, t)!,
      focusRing: Color.lerp(focusRing, other.focusRing, t)!,
      success: Color.lerp(success, other.success, t)!,
      successSoft: Color.lerp(successSoft, other.successSoft, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningSoft: Color.lerp(warningSoft, other.warningSoft, t)!,
      info: Color.lerp(info, other.info, t)!,
      infoSoft: Color.lerp(infoSoft, other.infoSoft, t)!,
    );
  }
}

extension NodThemeColors on BuildContext {
  NodColors get nodColors => Theme.of(this).extension<NodColors>()!;
}
