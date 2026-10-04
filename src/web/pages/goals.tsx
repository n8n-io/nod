import { PageTitle } from '../components/page-title';
import { useId, useState } from 'react';
import type { Goal } from '../../shared/contracts';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { DeletePlan } from '../components/delete-plan';
import { NewPlan, PlanFooter, PlanToast } from '../components/plan-controls';
import { formatCalendarDate, useDateFormat } from '../lib/date-format';

export function GoalRow({ goal, onAsk }: { goal: Goal; onAsk(text: string): void }) {
  const headingId = useId();
  const dateFormat = useDateFormat();
  return (
    <article className="saved-plan" aria-labelledby={headingId}>
      <div className="saved-plan-title">
        <h2 id={headingId}>{goal.title}</h2>
        <span className="saved-plan-status">{goal.status}</span>
      </div>
      {goal.description && <p className="saved-plan-description">{goal.description}</p>}
      {goal.status === 'completed' && (
        <div className="saved-goal-progress">
          <progress aria-label={`${goal.title} progress`} max={100} value={goal.progress} />
          <span>{goal.progress}%</span>
        </div>
      )}
      {goal.nextAction && goal.status !== 'completed' && (
        <p className="saved-plan-next">
          <span>Next</span>
          {goal.nextAction}
        </p>
      )}
      <PlanFooter
        kind="goal"
        item={goal}
        canPause={goal.status !== 'completed'}
        meta={goal.targetDate ? `Target ${formatCalendarDate(goal.targetDate, dateFormat)}` : ''}
        remove={<DeletePlan kind="goal" id={goal.id} title={goal.title} />}
        onAsk={onAsk}
      />
    </article>
  );
}

export function Goals({ onAsk }: { onAsk(text: string): void }) {
  const { data: goals, error, loading, refreshing, refresh } = usePageData<Goal[]>('/api/goals');
  const [view, setView] = useState<'active' | 'completed'>('active');
  const tabsId = useId();
  const active = (goals ?? []).filter((goal) => goal.status === 'active');
  const paused = (goals ?? []).filter((goal) => goal.status === 'paused');
  const completed = (goals ?? []).filter((goal) => goal.status === 'completed');
  return (
    <div className="content-page secondary-page goals-page">
      <PlanToast />
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/goals" />
          <p>Your goals and next steps.</p>
        </div>
        <div className="secondary-heading-actions">
          <NewPlan kind="goal" onAsk={onAsk} />
        </div>
      </header>
      <div
        className="goals-views"
        role="tablist"
        aria-label="Goal views"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'active'
              : event.key === 'End'
                ? 'completed'
                : view === 'active'
                  ? 'completed'
                  : 'active';
          setView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
        }}
      >
        {(['active', 'completed'] as const).map((item) => (
          <button
            key={item}
            id={`${tabsId}-tab-${item}`}
            data-view={item}
            role="tab"
            tabIndex={view === item ? 0 : -1}
            aria-selected={view === item}
            aria-controls={`${tabsId}-panel-${item}`}
            onClick={() => setView(item)}
          >
            {item === 'active' ? 'Active' : 'Completed'}
            {goals && <span>{item === 'active' ? active.length : completed.length}</span>}
          </button>
        ))}
      </div>
      {error && (
        <Notice>
          Could not load goals.{' '}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Retry loading goals"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </Notice>
      )}
      {(['active', 'completed'] as const).map((item) => (
        <div
          key={item}
          role="tabpanel"
          id={`${tabsId}-panel-${item}`}
          aria-labelledby={`${tabsId}-tab-${item}`}
          hidden={view !== item}
          tabIndex={view === item ? 0 : -1}
        >
          {view === item &&
            (!goals ? (
              loading ? (
                <div role="status">
                  <Loading label="Loading goals…" />
                </div>
              ) : null
            ) : view === 'completed' ? (
              completed.length ? (
                <div className="saved-plan-list">
                  {completed.map((goal) => (
                    <GoalRow key={goal.id} goal={goal} onAsk={onAsk} />
                  ))}
                </div>
              ) : (
                <div className="secondary-empty">
                  <h2>No completed goals yet</h2>
                  <p>Goals you finish will appear here.</p>
                </div>
              )
            ) : (
              <>
                {active.length ? (
                  <div className="saved-plan-list">
                    {active.map((goal) => (
                      <GoalRow key={goal.id} goal={goal} onAsk={onAsk} />
                    ))}
                  </div>
                ) : (
                  <div className="secondary-empty">
                    <h2>{goals.length ? 'No active goals' : 'No goals yet'}</h2>
                    <p>
                      {paused.length
                        ? 'Resume a paused goal or start something new.'
                        : 'Choose something to work toward and add your next step.'}
                    </p>
                  </div>
                )}
                {paused.length > 0 && (
                  <details className="goals-paused" open={!active.length}>
                    <summary>
                      Paused <span>{paused.length}</span>
                    </summary>
                    <div className="saved-plan-list">
                      {paused.map((goal) => (
                        <GoalRow key={goal.id} goal={goal} onAsk={onAsk} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            ))}
        </div>
      ))}
    </div>
  );
}
