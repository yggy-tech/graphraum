// The worker `openClusterLod` starts by default: builds cluster trees off the main thread.
import { serveClusterTreeWorker } from "./cluster-tree-job";

serveClusterTreeWorker(self);
