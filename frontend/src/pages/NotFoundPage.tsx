import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="page">
      <div className="state-block state-empty">
        <strong>404 — 页面不存在</strong>
        <span>当前地址没有对应的 PaperTeam 页面，可能是链接过期或输错了。</span>
        <Link to="/projects" className="btn btn-primary">
          返回论文项目
        </Link>
      </div>
    </section>
  );
}
