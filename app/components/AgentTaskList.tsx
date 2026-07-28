import {
  getAgentTasks,
  getTaskResults,
  type TaskStatus,
  type TaskStatusFilter,
} from "../lib/agent-project-records.mjs";

type AgentTaskListProps = {
  agentId: string;
  filter: TaskStatusFilter;
  onFilterChange: (filter: TaskStatusFilter) => void;
  onOpenResult: (taskId: string) => void;
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  waiting: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const FILTERS: ReadonlyArray<{
  value: TaskStatusFilter;
  label: string;
}> = [
  { value: "all", label: "全部" },
  { value: "waiting", label: STATUS_LABELS.waiting },
  { value: "running", label: STATUS_LABELS.running },
  { value: "completed", label: STATUS_LABELS.completed },
  { value: "failed", label: STATUS_LABELS.failed },
  { value: "stopped", label: STATUS_LABELS.stopped },
];

const timestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

const formatTimestamp = (timestamp: string) =>
  timestampFormatter.format(new Date(timestamp));

export function AgentTaskList({
  agentId,
  filter,
  onFilterChange,
  onOpenResult,
}: AgentTaskListProps) {
  const tasks = getAgentTasks(agentId, filter);

  return (
    <section aria-labelledby="agent-task-list-heading" className="agent-task-view">
      <div className="agent-task-view-heading">
        <div>
          <span className="eyebrow">TASK HISTORY</span>
          <h2 id="agent-task-list-heading">任务列表</h2>
        </div>
        <span>{tasks.length} 个任务</span>
      </div>

      <div aria-label="任务状态筛选" className="task-filter-bar" role="group">
        {FILTERS.map((item) => (
          <button
            aria-pressed={filter === item.value}
            className={filter === item.value ? "active" : ""}
            key={item.value}
            onClick={() => onFilterChange(item.value)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="agent-task-list">
        {tasks.length === 0 ? (
          <p className="agent-task-empty">当前筛选下暂无任务。</p>
        ) : (
          tasks.map((task) => {
            const hasResults = getTaskResults(task.id).length > 0;

            return (
              <article
                className={`agent-task-card status-${task.status}`}
                key={task.id}
              >
                <div className="agent-task-card-heading">
                  <div>
                    <h3>{task.title}</h3>
                    <span className={`agent-task-status status-${task.status}`}>
                      {STATUS_LABELS[task.status]}
                    </span>
                  </div>
                  <span className="agent-task-model">{task.model}</span>
                </div>

                <p className="agent-task-step">
                  <strong>当前步骤：</strong>
                  {task.currentStep}
                </p>

                {task.status === "running" ? (
                  <div className="task-progress">
                    <div className="task-progress-heading">
                      <span>任务进度</span>
                      <strong>{task.progress}%</strong>
                    </div>
                    <div
                      aria-label={`${task.title}进度`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={task.progress}
                      className="task-progress-track"
                      role="progressbar"
                    >
                      <span style={{ width: `${task.progress}%` }} />
                    </div>
                  </div>
                ) : null}

                {task.errorSummary ? (
                  <p className="agent-task-error" role="alert">
                    <strong>错误摘要：</strong>
                    {task.errorSummary}
                  </p>
                ) : null}

                <div className="agent-task-footer">
                  <div className="agent-task-timestamps">
                    <span>创建于 {formatTimestamp(task.createdAt)}</span>
                    <span>更新于 {formatTimestamp(task.updatedAt)}</span>
                  </div>
                  {hasResults ? (
                    <button
                      className="agent-task-result"
                      onClick={() => onOpenResult(task.id)}
                      type="button"
                    >
                      查看成果
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
