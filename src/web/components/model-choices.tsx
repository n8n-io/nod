import { Fragment } from 'react';
import type { Schedule, Task } from '../../shared/contracts';
import {
  canReuseWorkCost,
  repriceUsd,
  routeModel,
  type ModelLane,
  type ModelSelection,
  type ModelsResponse,
  type WorkKind,
  type WorkUsage,
  type WorkUsageResponse,
} from '../../shared/models';
import { defaultEffort } from '../../shared/model-defaults';
import type { Bot } from '../../shared/bots';
import { useModels } from '../hooks/use-models';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { money } from '../lib/money';
import { pageDataCache } from '../lib/page-data-cache';
import { schedulesPath } from '../lib/schedule-reconciliation';
import { ModelPicker, type ModelTarget } from './models';

const workUsagePath = '/api/usage/work';
const kindNames: Record<WorkKind, string> = {
  chat: 'chat',
  schedule: 'schedules',
  background: 'Nod’s own work',
};

function modelOf(data: ModelsResponse, choice: ModelSelection | null | undefined) {
  return data.connections
    .find((item) => item.id === choice?.connectionId)
    ?.models.find((item) => item.id === choice?.modelId);
}

const unavailableLabel = 'an unavailable model';

function kept(data: ModelsResponse, choice: ModelSelection | null | undefined) {
  return choice && data.connections.some((item) => item.id === choice.connectionId) ? choice : null;
}

function same(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined) {
  return (
    a?.connectionId === b?.connectionId && a?.modelId === b?.modelId && a?.effort === b?.effort
  );
}

async function saved<T>(path: string, body: unknown, update: (value: T) => void) {
  try {
    update(await api<T>(path, { method: 'PUT', body: JSON.stringify(body) }));
    void pageDataCache.refresh(workUsagePath, true);
    return true as const;
  } catch (cause) {
    return errorMessage(cause);
  }
}

function laneTarget(
  data: ModelsResponse,
  lane: ModelLane,
  usage: WorkUsage | undefined,
): ModelTarget {
  const value = data.routes?.[lane] ?? null;
  return {
    title: lane === 'schedule' ? 'Model for schedules' : 'Model for work Nod starts on its own',
    value: value === 'light' ? value : kept(data, value),
    defaults: [
      { value: null, label: 'The same model', model: data.selection },
      ...(data.light
        ? [{ value: 'light' as const, label: 'The light model', model: data.light }]
        : []),
    ],
    usage,
    save: (route) =>
      saved<ModelsResponse>('/api/models/routes', { lane, route }, (result) =>
        pageDataCache.update('/api/models', () => result),
      ),
  };
}

function backupTarget(data: ModelsResponse, index: number): ModelTarget {
  const list = data.backups ?? [];
  return {
    title: index < list.length ? `Backup model ${index + 1}` : 'Add a backup model',
    value: list[index] ?? null,
    defaults: index < list.length ? [{ value: null, label: 'No backup', model: null }] : [],
    save: (choice) => {
      const next = [...list];
      if (choice && choice !== 'light') next[index] = choice;
      else next.splice(index, 1);
      return saved<ModelsResponse>('/api/models/backups', { backups: next }, (result) =>
        pageDataCache.update('/api/models', () => result),
      );
    },
  };
}

function scheduleTarget(
  data: ModelsResponse,
  schedule: Schedule,
  usage: WorkUsage | undefined,
): ModelTarget {
  return {
    title: `Model for ${schedule.title}`,
    value: kept(data, schedule.model),
    defaults: [
      {
        value: null,
        label: 'Same as schedules',
        model: routeModel(data, 'schedule')?.selection ?? null,
      },
    ],
    usage,
    save: (model) =>
      saved<Schedule>(
        `${schedulesPath}/${encodeURIComponent(schedule.id)}/model`,
        { model },
        (result) =>
          pageDataCache.update<Schedule[]>(
            schedulesPath,
            (items) => items?.map((item) => (item.id === result.id ? result : item)) ?? items,
          ),
      ),
  };
}

function taskTarget(
  data: ModelsResponse,
  task: Task & { work: WorkKind },
  usage: WorkUsage | undefined,
): ModelTarget {
  return {
    title: `Model for ${task.title}`,
    value: kept(data, task.model),
    defaults: [
      {
        value: null,
        label: task.scheduleModel ? 'Same as its schedule' : `Same as ${kindNames[task.work]}`,
        model: routeModel(data, task.work, { schedule: task.scheduleModel })?.selection ?? null,
      },
    ],
    usage,
    save: (model) =>
      saved<Task>(`/api/tasks/${encodeURIComponent(task.id)}/model`, { model }, (result) =>
        pageDataCache.update<Task[]>(
          '/api/tasks',
          (items) => items?.map((item) => (item.id === result.id ? result : item)) ?? items,
        ),
      ),
  };
}

function estimate(
  data: ModelsResponse,
  parts: Array<{ usage: WorkUsage | undefined; model: ModelSelection | null | undefined }>,
) {
  let recorded = 0;
  let projected = 0;
  const unpriced = new Set<string>();
  for (const { usage, model } of parts) {
    const spent = usage ? usage.agentUsd + usage.otherUsd : 0;
    if (!usage || spent <= 0) continue;
    recorded += spent;
    const choice = modelOf(data, model);
    if (choice && canReuseWorkCost(usage, choice.id, choice.pricing)) {
      projected += spent;
      continue;
    }
    const value = choice && repriceUsd(usage, choice.pricing, choice.audio);
    if (value === null || value === undefined) unpriced.add(choice?.name ?? unavailableLabel);
    else projected += value;
  }
  return { recorded, projected, unpriced: [...unpriced] };
}

export function ModelSentences() {
  const models = useModels();
  const usage = usePageData<WorkUsageResponse>(workUsagePath);
  const schedules = usePageData<Schedule[]>(schedulesPath);
  const tasks = usePageData<Task[]>('/api/tasks');
  const data = models.data;
  if (!data) return null;
  const chat = modelOf(data, data.selection);
  const backups = data.backups ?? [];
  const lane = (kind: ModelLane) => {
    const value = data.routes?.[kind];
    const light = value === 'light' && data.light && modelOf(data, data.light);
    const own = value === 'light' ? null : kept(data, value);
    return (
      <>
        <ModelPicker
          appearance="statement"
          manageConnections={false}
          target={laneTarget(data, kind, usage.data?.lanes[kind])}
          label={
            light
              ? 'the light model'
              : own
                ? (modelOf(data, own)?.name ?? unavailableLabel)
                : 'the same model'
          }
        />
        {light ? `, ${light.name}` : ''}
      </>
    );
  };
  const ownSchedules = (schedules.data ?? []).filter(
    (schedule) =>
      kept(data, schedule.model) &&
      !same(
        routeModel(data, 'schedule', { schedule: schedule.model })?.selection,
        routeModel(data, 'schedule')?.selection,
      ),
  );
  const ownTasks = (tasks.data ?? []).filter(
    (task): task is Task & { work: WorkKind } =>
      Boolean(task.work && kept(data, task.model)) &&
      !task.closedAt &&
      !same(task.model, routeModel(data, task.work!, { schedule: task.scheduleModel })?.selection),
  );
  const work = usage.data;
  const price =
    work &&
    estimate(data, [
      { usage: work.lanes.chat, model: data.selection },
      { usage: work.lanes.schedule, model: routeModel(data, 'schedule')?.selection },
      { usage: work.lanes.background, model: routeModel(data, 'background')?.selection },
      ...(work.own ?? []).map(({ kind, task, schedule, ...usage }) => ({
        usage,
        model: routeModel(data, kind, { task, schedule })?.selection,
      })),
    ]);
  return (
    <section className="model-current-section" aria-label="Your models">
      <div className="statement-summary model-sentences">
        <p>
          When you talk to Nod, it uses{' '}
          <ModelPicker
            appearance="statement"
            manageConnections={false}
            usage={work?.lanes.chat}
            label={chat?.name ?? 'no model yet'}
          />
          .
        </p>
        {chat && (
          <p>
            If it’s busy or unavailable, Nod tries{' '}
            {backups.length
              ? backups.map((choice, index) => (
                  <Fragment key={index}>
                    {index ? ', then ' : ''}
                    <ModelPicker
                      appearance="statement"
                      manageConnections={false}
                      target={backupTarget(data, index)}
                      label={`${modelOf(data, choice)?.name ?? unavailableLabel}${
                        choice.connectionId === data.selection?.connectionId &&
                        choice.modelId === data.selection?.modelId
                          ? ' (already your chat model)'
                          : ''
                      }`}
                    />
                  </Fragment>
                ))
              : 'no other model'}
            .
          </p>
        )}
        <p>Schedules use {lane('schedule')}.</p>
        <p>Work Nod starts on its own uses {lane('background')}.</p>
        {ownSchedules.map((schedule) => (
          <p key={schedule.id}>
            {schedule.title} uses{' '}
            <ModelPicker
              appearance="statement"
              manageConnections={false}
              target={scheduleTarget(data, schedule, work?.schedules[schedule.id])}
              label={modelOf(data, schedule.model)?.name ?? unavailableLabel}
            />
            .
          </p>
        ))}
        {ownTasks.map((task) => (
          <p key={task.id}>
            {task.title} uses{' '}
            <ModelPicker
              appearance="statement"
              manageConnections={false}
              target={taskTarget(data, task, work?.tasks[task.id])}
              label={modelOf(data, task.model)?.name ?? unavailableLabel}
            />
            .
          </p>
        ))}
      </div>
      {chat && backups.length < 3 && (
        <p className="model-sentences-note">
          <ModelPicker
            appearance="statement"
            manageConnections={false}
            target={backupTarget(data, backups.length)}
            label="Add a backup model"
          />
        </p>
      )}
      {chat?.audio && (
        <p className="model-sentences-note">
          {chat.textModelName ? `Text support: ${chat.textModelName}` : 'Text model unavailable'}
        </p>
      )}
      {price && price.recorded > 0 && (
        <p className="model-sentences-note" role="status">
          {price.unpriced.length
            ? `Work on ${price.unpriced.join(' and ')} has no price in Nod.`
            : Math.abs(price.projected - price.recorded) >= 0.01
              ? `With these choices, the last 30 days would have cost about ${money(price.projected)} instead of ${money(price.recorded)}.`
              : `Last 30 days: ${money(price.recorded)}.`}
        </p>
      )}
    </section>
  );
}

export function WorkModel({ task }: { task: Task }) {
  const models = useModels();
  const usage = usePageData<WorkUsageResponse>(workUsagePath);
  const data = models.data;
  const kind = task.work;
  if (!data || !kind) return null;
  const current = routeModel(data, kind, { task: task.model, schedule: task.scheduleModel });
  if (!current) return null;
  const chosen = modelOf(data, current.selection);
  const follows =
    current.follows === 'task'
      ? 'its own choice'
      : current.follows === 'schedule'
        ? 'same as its schedule'
        : current.follows === 'light'
          ? `same as ${kindNames[kind]}, the light model`
          : `same as ${kindNames[kind]}`;
  return (
    <div className="work-model">
      <span className="work-model-label">Model</span>
      <span className="work-model-value">
        <strong>{chosen?.name ?? 'Model unavailable'}</strong> · {follows}
      </span>
      <ModelPicker
        manageConnections={false}
        target={taskTarget(data, { ...task, work: kind }, usage.data?.tasks[task.id])}
        label="Change"
        appearance="quiet"
      />
    </div>
  );
}

export function ScheduleCost({ schedule }: { schedule: Schedule }) {
  const models = useModels();
  const usage = usePageData<WorkUsageResponse>(workUsagePath);
  const data = models.data;
  const current = data && routeModel(data, 'schedule', { schedule: schedule.model });
  const name = data && current ? modelOf(data, current.selection)?.name : undefined;
  const spent = usage.data?.schedules[schedule.id];
  const recent = spent ? spent.agentUsd + spent.otherUsd : 0;
  if (schedule.kind !== 'recurring' && recent <= 0) return null;
  return (
    <div className="work-model">
      <span className="work-model-label">Expected cost</span>
      <span className="work-model-value">
        {schedule.monthlyUsd !== null ? (
          <>
            <strong>≈{money(schedule.monthlyUsd)} a month</strong>
            {name && ` on ${name}`}
            {recent > 0 && ` · ${money(recent)} in the last 30 days`}
          </>
        ) : schedule.kind === 'recurring' ? (
          <>
            <strong>No estimate yet</strong>
            {recent > 0 && ` · ${money(recent)} in the last 30 days`}
          </>
        ) : (
          <>
            <strong>{money(recent)}</strong> in the last 30 days
          </>
        )}
      </span>
    </div>
  );
}

export function ScheduleModel({ schedule }: { schedule: Schedule }) {
  const models = useModels();
  const usage = usePageData<WorkUsageResponse>(workUsagePath);
  const data = models.data;
  if (!data) return null;
  const current = routeModel(data, 'schedule', { schedule: schedule.model });
  if (!data.connections.some((item) => item.status === 'connected')) return null;
  return (
    <ModelPicker
      manageConnections={false}
      target={scheduleTarget(data, schedule, usage.data?.schedules[schedule.id])}
      label={current && !modelOf(data, current.selection) ? 'Model unavailable' : undefined}
    />
  );
}

export function BotModel({ bot, onError }: { bot: Bot; onError(message: string): void }) {
  const models = useModels();
  const data = models.data;
  if (!data)
    return (
      <select className="input panel-select" disabled aria-label="Model">
        <option>…</option>
      </select>
    );
  const own = kept(data, bot.model);
  const choices = data.connections
    .filter((connection) => connection.status === 'connected')
    .flatMap((connection) =>
      connection.models.map((model) => ({
        key: `${connection.id}/${model.id}`,
        label: model.name,
        model: {
          connectionId: connection.id,
          modelId: model.id,
          effort: defaultEffort(model),
        } satisfies ModelSelection,
      })),
    );
  const value = own ? `${own.connectionId}/${own.modelId}` : '';
  return (
    <select
      className="input panel-select"
      aria-label="Model"
      value={value}
      onChange={(event) => {
        const model = choices.find((choice) => choice.key === event.target.value)?.model;
        if (!model) return;
        void api<Bot>(`/api/bots/${encodeURIComponent(bot.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        })
          .then(() => {
            window.dispatchEvent(new Event('nod:bots-changed'));
            void pageDataCache.refresh(workUsagePath, true);
          })
          .catch((cause) => onError(errorMessage(cause)));
      }}
    >
      {!own && (
        <option value="" disabled>
          Model unavailable
        </option>
      )}
      {own && !choices.some((choice) => choice.key === value) && (
        <option value={value}>{modelOf(data, own)?.name ?? unavailableLabel}</option>
      )}
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

export function NodModelName() {
  const models = useModels();
  const data = models.data;
  return <>{data ? (modelOf(data, data.selection)?.name ?? 'Model unavailable') : '…'}</>;
}
