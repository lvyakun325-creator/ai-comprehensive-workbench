import { AGENT_PROJECTS } from "../lib/agent-catalog.mjs";
import { PREVIEW_TASK_SCHEDULE } from "../lib/workbench-preview.mjs";
import type { PreviewTaskStatus } from "../lib/workbench-preview.mjs";

type TaskCenterProps = {
  onPreview: (message: string) => void;
};

const STATUS_LABELS: Record<PreviewTaskStatus, string> = {
  running: "运行中",
  queued: "排队中",
  approval: "待人工确认",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停",
};

export function TaskCenter({ onPreview }: TaskCenterProps) {
  const scheduledTasks = [
    ...PREVIEW_TASK_SCHEDULE.running.map((task) => ({
      ...task,
      status: "running" as const,
    })),
    ...PREVIEW_TASK_SCHEDULE.queued.map((task) => ({
      ...task,
      status: "queued" as const,
    })),
  ];

  return (
    <section className="task-center">
      <header className="section-heading">
        <div>
          <span className="eyebrow">TASK ORCHESTRATION</span>
          <h2>任务中心</h2>
        </div>
        <div className="task-capacity">
          {PREVIEW_TASK_SCHEDULE.capacityLabel}
        </div>
      </header>
      <div className="task-filters" aria-label="任务状态筛选">
        {["全部", "运行中", "排队中", "待人工确认", "已完成", "失败", "已暂停"].map(
          (label) => <button key={label} onClick={() => onPreview("当前为设计预览，未暂停或终止真实任务")}>{label}</button>,
        )}
      </div>
      <div className="task-list">
        {scheduledTasks.map((task) => {
          const agent = AGENT_PROJECTS.find(({ id }) => id === task.agentId);
          return (
            <button
              className="task-card"
              key={task.id}
              onClick={() => onPreview("当前为设计预览，未暂停或终止真实任务")}
            >
              <span>{STATUS_LABELS[task.status]}</span>
              <strong>{task.title}</strong>
              <small>{agent?.title}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
