import { api } from "../api/client";
import { createRunLog } from "./pendingRuns";

// POST /runs идемпотентен по id: повтор после закрытия окна безопасен.
export const { submitRun, flushPendingRuns } = createRunLog((run) => api.postRun(run), () => localStorage);
