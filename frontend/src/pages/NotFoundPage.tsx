import { Link } from "react-router-dom";

/** 404（M4.1） */
export function NotFoundPage() {
  return (
    <section className="page">
      <div className="state-block state-empty">
        <strong>404 — 页面不存在</strong>
        <span>当前地址没有对应的 PaperTeam 页面。</span>
        <Link to="/projects" className="btn btn-primary">
          返回项目列表
        </Link>
      </div>
    </section>
  );
}
