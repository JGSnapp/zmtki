// Re-export workspace module — persistence is directory-only (no separate DB file).
export {
  WORKSPACE_DIR,
  PLANE_FILE,
  NOTIFY_FILE,
  newId,
  nowIso,
  ensureWorkspace as ensureDataFile,
  readBoard,
  writeBoard,
  updateBoard,
  normalizeBoard,
  normalizeElement,
  mergeElement,
  writeCardMarkdown,
  getWorkspaceDir,
  setWorkspaceDir,
  touchWorkspaceNotify
} from "./workspace.js";
