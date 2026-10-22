import { sidebarItems } from '../lib/navigation';

export function PageTitle({ path }: { path: (typeof sidebarItems)[number]['path'] }) {
  const item = sidebarItems.find((entry) => entry.path === path)!;
  const Icon = item.icon;
  return (
    <div className="page-title-row">
      <h1 className="page-title" data-analytics-public>
        <Icon size={24} aria-hidden="true" />
        {item.label}
      </h1>
    </div>
  );
}
