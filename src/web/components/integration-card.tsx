import { Tooltip } from './tooltip';
import type { ReactNode } from 'react';

export function IntegrationCard({
  id,
  name,
  logo,
  description,
  detail,
  badge,
  actions,
  className = '',
}: {
  id: string;
  name: string;
  logo: ReactNode;
  description?: string;
  detail?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <article className={`integration-card ${className}`} aria-labelledby={id}>
      <div className="integration-card-logo">{logo}</div>
      <div className="integration-card-copy">
        <div className="integration-card-heading">
          <Tooltip content={name}>
            <h3 id={id}>{name}</h3>
          </Tooltip>
          {badge}
        </div>
        {description && (
          <Tooltip content={description}>
            <p className="integration-card-description">{description}</p>
          </Tooltip>
        )}
        {detail && <div className="integration-card-detail">{detail}</div>}
      </div>
      {actions && <div className="integration-card-actions">{actions}</div>}
    </article>
  );
}
