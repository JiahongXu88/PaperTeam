import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "../components/layout/AppLayout.js";
import { NewProjectPage } from "../pages/NewProjectPage.js";
import { NotFoundPage } from "../pages/NotFoundPage.js";
import { ProjectPage } from "../pages/ProjectPage.js";
import { ProjectsPage } from "../pages/ProjectsPage.js";

/**
 * 路由（M4.1/M4.2）：
 *   /                     → redirect /projects
 *   /projects             → 项目列表
 *   /projects/new         → 创建项目
 *   /projects/:projectId  → Project Workspace 基础壳
 *   *                     → 404
 *
 * Workflow Live View（/projects/:id/workflow 等）在 M4.3 落地时再加，
 * 不预建空页面。
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
