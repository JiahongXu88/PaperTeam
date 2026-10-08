/** Independent process used to terminate a real restore at a disk boundary. */
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";

const [root, projectId, revision] = process.argv.slice(2);
if (!root || !projectId || !revision) process.exit(2);
const store = new ManuscriptRevisionStore({ projects: new ProjectStore({ root }) });
await store.restore(projectId, Number(revision));
