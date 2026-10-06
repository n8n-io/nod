import { navigationItems } from '../lib/navigation';

export function PageTitle({ path }: { path: (typeof navigationItems)[number]['path'] }) {
  const item = navigationItems.find((entry) => entry.path === path)!;
  const Icon = item.icon;
  return (
    <h1 className="page-title" data-analytics-public>
      <Icon size={24} aria-hidden="true" />
      {item.label}
    </h1>
  );
}
