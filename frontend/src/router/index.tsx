import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "../components/layout/AppLayout.js";
import { NewProjectPage } from "../pages/NewProjectPage.js";
import { NotFoundPage } from "../pages/NotFoundPage.js";
import { ProjectPage } from "../pages/ProjectPage.js";
import { ProjectsPage } from "../pages/ProjectsPage.js";
import { SkillsPage } from "../pages/SkillsPage.js";

/**
 * 路由（M4.1-M4.3）：
 *   /                     → redirect /projects
 *   /projects             → 项目列表
 *   /projects/new         → 创建项目
 *   /projects/:projectId  → Project Workspace（Overview / PDF / Citations / …）
 *   /skills               → Skill Registry（M4.3.6/7）
 *   *                     → 404
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
