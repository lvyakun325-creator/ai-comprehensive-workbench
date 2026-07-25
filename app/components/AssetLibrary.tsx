import { createHandoffPreview } from "../lib/workbench-state.mjs";

type AssetLibraryProps = {
  onPreview: (message: string) => void;
};

const ASSET_GROUPS = [
  ["私有成果", "仅所属 Agent 项目可见"],
  ["待交接成果", "等待确认目标和使用范围"],
  ["已共享成果", "目标 Agent 获得只读副本"],
  ["公共资产只读", "品牌、产品、平台和合规模板"],
] as const;

export function AssetLibrary({ onPreview }: AssetLibraryProps) {
  const handoff = createHandoffPreview(
    "competitor-insight",
    "content-matrix",
    "competitor-insight-report-v1",
  );

  return (
    <section className="asset-library">
      <header className="section-heading">
        <div>
          <span className="eyebrow">ARTIFACT LIBRARY</span>
          <h2>成果资产库</h2>
        </div>
        <p>所有交接仅生成预览，不会写入其他 Agent 项目。</p>
      </header>
      <div className="asset-group-grid">
        {ASSET_GROUPS.map(([title, description]) => (
          <button key={title} className="asset-group" onClick={() => onPreview("当前为设计预览，未创建或共享真实成果")}> 
            <strong>{title}</strong>
            <small>{description}</small>
          </button>
        ))}
      </div>
      <button className="handoff-card" onClick={() => onPreview("当前为设计预览，未创建或共享真实成果")}>
        <span>竞品洞察 Agent</span>
        <b>竞品洞察报告 v1</b>
        <span>→ 内容矩阵 Agent</span>
        <em>{handoff.access === "readonly-copy" ? "只读副本" : "不可用"} · 等待确认</em>
      </button>
    </section>
  );
}
