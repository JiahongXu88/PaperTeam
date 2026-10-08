/** Launched by figureHttp.test in a separate process; SIGKILL occurs at the write boundary. */
import { join } from "node:path";
import { FigureService } from "../../src/figures/FigureService.js";
import { FigureCompiler } from "../../src/figures/FigureCompiler.js";

const [manuscriptDir, researchDir, projectId, figId] = process.argv.slice(2);
if (!manuscriptDir || !researchDir || !projectId || !figId) process.exit(2);
const service = new FigureService({
  projects: {
    getRequired: async () => ({ workflowKind: "idea_to_paper" }),
    manuscriptDir: () => manuscriptDir,
    mainTexPath: () => join(manuscriptDir, "main.tex"),
    researchDir: () => researchDir,
  } as never,
  sources: { list: async () => [] } as never,
  documents: {} as never,
  revisions: { currentRevision: async () => 0 } as never,
  compiler: new FigureCompiler(),
});
await service.insert(projectId, { figId, mode: "append", sectionId: "results" });
process.exit(0);
