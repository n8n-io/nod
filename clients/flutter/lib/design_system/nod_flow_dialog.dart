import 'package:flutter/material.dart';

import 'nod_tokens.dart';

class NodFlowDialog extends StatelessWidget {
  const NodFlowDialog({
    required this.title,
    required this.child,
    required this.actions,
    super.key,
  });

  final String title;
  final Widget child;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.all(NodSpacing.md),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 520,
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
        child: Padding(
          padding: const EdgeInsets.all(NodSpacing.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                header: true,
                namesRoute: true,
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
              ),
              const SizedBox(height: NodSpacing.md),
              Flexible(child: SingleChildScrollView(child: child)),
              const SizedBox(height: NodSpacing.lg),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: NodSpacing.sm,
                runSpacing: NodSpacing.sm,
                children: actions,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
