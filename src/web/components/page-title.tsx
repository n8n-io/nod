import { sidebarItems } from '../lib/navigation';

export function PageTitle({ path }: { path: (typeof sidebarItems)[number]['path'] }) {
  const item = sidebarItems.find((entry) => entry.path === path)!;
  return (
    <div className="page-title-row">
      <h1 className="page-title" data-analytics-public>
        {item.label}
      </h1>
    </div>
  );
}
