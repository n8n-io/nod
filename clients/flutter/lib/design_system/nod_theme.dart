import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'nod_tokens.dart';

abstract final class NodTheme {
  static final light = _theme(Brightness.light);
  static final dark = _theme(Brightness.dark);

  static ThemeData _theme(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final nodColors = isDark ? NodColors.dark : NodColors.light;
    final scheme = ColorScheme(
      brightness: brightness,
      primary: NodPalette.brandPink,
      onPrimary: NodPalette.black,
      primaryContainer: isDark ? NodPalette.pink80 : NodPalette.pink20,
      onPrimaryContainer: isDark ? NodPalette.white : NodPalette.black,
      secondary: nodColors.accent,
      onSecondary: isDark ? NodPalette.black : NodPalette.white,
      secondaryContainer: nodColors.accentSoft,
      onSecondaryContainer: isDark ? NodPalette.white : NodPalette.black,
      tertiary: nodColors.info,
      onTertiary: isDark ? NodPalette.black : NodPalette.white,
      tertiaryContainer: nodColors.infoSoft,
      onTertiaryContainer: isDark ? NodPalette.white : NodPalette.black,
      error: isDark ? const Color(0xFFFFACB9) : const Color(0xFFA52842),
      onError: isDark ? NodPalette.black : NodPalette.white,
      errorContainer: isDark
          ? const Color(0xFF3D252E)
          : const Color(0xFFFFF0F2),
      onErrorContainer: isDark
          ? const Color(0xFFFFACB9)
          : const Color(0xFFA52842),
      surface: nodColors.canvas,
      onSurface: isDark ? NodPalette.white : NodPalette.black,
      surfaceContainerLowest: isDark ? NodPalette.black : NodPalette.gray0,
      surfaceContainerLow: nodColors.sidebar,
      surfaceContainer: nodColors.surfaceSubtle,
      surfaceContainerHigh: nodColors.surfaceInset,
      surfaceContainerHighest: isDark ? NodPalette.gray80 : NodPalette.gray25,
      onSurfaceVariant: nodColors.mutedForeground,
      outline: nodColors.border,
      outlineVariant: isDark ? NodPalette.gray80 : NodPalette.gray30,
      shadow: NodPalette.black,
      scrim: NodPalette.black,
      inverseSurface: isDark ? NodPalette.white : NodPalette.black,
      onInverseSurface: isDark ? NodPalette.black : NodPalette.white,
      inversePrimary: NodPalette.brandPink,
    );
    final fontFamily = switch (defaultTargetPlatform) {
      TargetPlatform.android || TargetPlatform.fuchsia => 'Roboto',
      TargetPlatform.iOS || TargetPlatform.macOS => '.SF Pro Text',
      TargetPlatform.windows => 'Segoe UI',
      TargetPlatform.linux => 'Lato',
    };
    final baseText = Typography.material2021(
      platform: defaultTargetPlatform,
      colorScheme: scheme,
    ).black.apply(fontFamily: fontFamily);
    final textTheme = baseText
        .copyWith(
          displaySmall: baseText.displaySmall?.copyWith(
            fontSize: NodTypography.display,
            height: 1.12,
            fontWeight: FontWeight.w600,
            letterSpacing: NodTypography.displayTracking,
          ),
          headlineMedium: baseText.headlineMedium?.copyWith(
            fontSize: NodTypography.headline,
            height: 1.15,
            fontWeight: FontWeight.w600,
            letterSpacing: NodTypography.headlineTracking,
          ),
          headlineSmall: baseText.headlineSmall?.copyWith(
            fontSize: NodTypography.title,
            height: 1.2,
            fontWeight: FontWeight.w500,
            letterSpacing: NodTypography.headlineTracking,
          ),
          titleLarge: baseText.titleLarge?.copyWith(
            fontSize: NodTypography.titleSmall,
            height: 1.25,
            fontWeight: FontWeight.w600,
            letterSpacing: NodTypography.titleTracking,
          ),
          titleMedium: baseText.titleMedium?.copyWith(
            fontSize: NodTypography.body,
            height: 1.35,
            fontWeight: FontWeight.w600,
          ),
          bodyLarge: baseText.bodyLarge?.copyWith(
            fontSize: NodTypography.body,
            height: 1.5,
          ),
          bodyMedium: baseText.bodyMedium?.copyWith(
            fontSize: NodTypography.control,
            height: 1.45,
          ),
          labelLarge: baseText.labelLarge?.copyWith(
            fontSize: NodTypography.control,
            height: 1.2,
            fontWeight: FontWeight.w600,
          ),
        )
        .apply(bodyColor: scheme.onSurface, displayColor: scheme.onSurface);
    final focusBorder = nodColors.focusRing.withValues(alpha: 0.55);
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: nodColors.canvas,
      textTheme: textTheme,
      fontFamily: fontFamily,
      extensions: [nodColors],
      visualDensity: VisualDensity.standard,
      splashFactory: InkSparkle.splashFactory,
      focusColor: NodPalette.brandPink.withValues(alpha: 0.16),
      hoverColor: nodColors.accentSoft.withValues(alpha: 0.6),
      dividerColor: nodColors.border,
      appBarTheme: AppBarTheme(
        backgroundColor: nodColors.canvas,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(NodSizes.touchTarget, NodSizes.touchTarget),
          padding: const EdgeInsets.symmetric(horizontal: NodSpacing.lg),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(NodSizes.touchTarget, NodSizes.touchTarget),
          padding: const EdgeInsets.symmetric(horizontal: NodSpacing.lg),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(NodSizes.touchTarget, NodSizes.touchTarget),
          padding: const EdgeInsets.symmetric(horizontal: NodSpacing.md),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 72,
        backgroundColor: nodColors.sidebar,
        surfaceTintColor: Colors.transparent,
        indicatorColor: nodColors.accentSoft,
        indicatorShape: const StadiumBorder(),
        labelTextStyle: WidgetStateProperty.resolveWith((states) {
          return textTheme.labelMedium?.copyWith(
            color: states.contains(WidgetState.selected)
                ? scheme.onSurface
                : nodColors.mutedForeground,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w600
                : FontWeight.w500,
          );
        }),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          return IconThemeData(
            color: states.contains(WidgetState.selected)
                ? nodColors.accent
                : nodColors.mutedForeground,
            size: 24,
          );
        }),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: Colors.transparent,
        selectedColor: nodColors.accentSoft,
        side: BorderSide(color: nodColors.border),
        shape: const StadiumBorder(),
        labelStyle: textTheme.labelLarge,
        padding: const EdgeInsets.symmetric(horizontal: NodSpacing.xs),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? NodPalette.black : NodPalette.gray0,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: NodSpacing.md,
          vertical: NodSpacing.sm,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(NodRadii.input),
          borderSide: BorderSide(color: nodColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(NodRadii.input),
          borderSide: BorderSide(color: nodColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(NodRadii.input),
          borderSide: BorderSide(color: focusBorder, width: 1.5),
        ),
      ),
    );
  }
}
