import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "../components/layout/AppLayout.js";
import { SettingsLayout } from "../components/layout/SettingsLayout.js";
import { AppearanceSettingsPage } from "../pages/AppearanceSettingsPage.js";
import { ModelSettingsPage } from "../pages/ModelSettingsPage.js";
import { NewProjectPage } from "../pages/NewProjectPage.js";
import { NotFoundPage } from "../pages/NotFoundPage.js";
import { ProjectManagementSettingsPage } from "../pages/ProjectManagementSettingsPage.js";
import { ProjectPage } from "../pages/ProjectPage.js";
import { ProjectsPage } from "../pages/ProjectsPage.js";
import { SkillsPage } from "../pages/SkillsPage.js";

/**
 * 路由表。只挂真实可用的页面，未完成模块不占一级入口。
 *
 *   /                      → /projects
 *   /projects              论文项目列表
 *   /projects/new          新建项目（从研究想法开始 / 导入已有论文）
 *   /projects/:projectId   项目工作区（?tab=overview|pdf|citations|review）
 *   /skills                Skills
 *   /settings              → /settings/model
 *     /settings/model        模型设置
 *     /settings/appearance   外观（主题）
 *     /settings/projects     项目管理（已归档项目：恢复 / 永久删除）
 *   *                      404
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
          <Route path="appearance" element={<AppearanceSettingsPage />} />
          <Route path="projects" element={<ProjectManagementSettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
