import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "../components/layout/AppLayout.js";
import { SettingsLayout } from "../components/layout/SettingsLayout.js";
import { ModelSettingsPage } from "../pages/ModelSettingsPage.js";
import { NewProjectPage } from "../pages/NewProjectPage.js";
import { NotFoundPage } from "../pages/NotFoundPage.js";
import { ProjectManagementSettingsPage } from "../pages/ProjectManagementSettingsPage.js";
import { ProjectPage } from "../pages/ProjectPage.js";
import { ProjectsPage } from "../pages/ProjectsPage.js";
import { SkillsPage } from "../pages/SkillsPage.js";

/**
 * 路由（M4.1-M4.3 + 2026-09 生命周期收口）：
 *   /                     → redirect /projects
 *   /projects             → 项目列表（默认未归档）
 *   /projects/new         → 新建项目（从研究想法开始 / 导入已有论文）
 *   /projects/:projectId  → Project Workspace（Overview / PDF / Citations / Review）
 *   /skills               → Skill Registry（M4.3.6/7）
 *   /settings             → Settings 二级导航（redirect /settings/model）
 *     /settings/model       模型设置（M4.3.7.5）
 *     /settings/projects    项目管理（已归档：恢复 / 永久删除）
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
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/model" replace />} />
          <Route path="model" element={<ModelSettingsPage />} />
          <Route path="projects" element={<ProjectManagementSettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
