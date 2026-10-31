import { useCallback } from 'react';
import { observeAnalyticsView, type AnalyticsProperties } from '../lib/analytics';

export function useAnalyticsView<
  Element extends HTMLElement,
  Event extends 'nod_presentation_viewed' | 'nod_artifact_viewed' | 'nod_answer_choices_viewed',
>(event: Event, properties: AnalyticsProperties<Event>, key: string, enabled = true) {
  const serialized = JSON.stringify(properties);
  return useCallback(
    (element: Element | null) => {
      if (!enabled || !element) return;
      return observeAnalyticsView(element, key, event, JSON.parse(serialized));
    },
    [enabled, event, key, serialized],
  );
}
