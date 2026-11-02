import { SearchPicker } from './search-picker';

const timeZoneLabels = {
  choose: 'Choose time zone',
  search: 'Search time zones',
  placeholder: 'Search city or time zone',
  clear: 'Clear time zone search',
  list: 'Time zones',
  empty: 'No time zones found.',
};

export function TimeZonePicker({
  zones,
  ...props
}: {
  value: string;
  zones: string[];
  disabled?: boolean;
  labelledBy: string;
  onChange(value: string): void;
}) {
  return (
    <SearchPicker
      {...props}
      options={zones.map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }))}
      labels={timeZoneLabels}
    />
  );
}
