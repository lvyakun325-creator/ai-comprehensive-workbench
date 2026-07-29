const METRICS = [
  ["内容产能", "128", "本周模拟产出"],
  ["平均完成率", "86%", "模拟任务口径"],
  ["Agent 调用量", "342", "不含真实接口调用"],
  ["待复盘项目", "6", "等待数据确认"],
] as const;

export function DataOverview() {
  return (
    <section className="data-overview">
      <span className="eyebrow">OPERATING OVERVIEW</span>
      <h2>数据概览</h2>
      <p>当前全部为界面模拟数据，不读取真实平台经营数据。</p>
      <div className="metric-grid">
        {METRICS.map(([label, value, note]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
