kubectl is configured for the production cluster, namespace {NS}. It runs an orders stack: frontend -> backend Service -> backend pods, plus a worker. Since this morning's deploy, frontend keeps crashing, backend receives no traffic and worker never starts.
1. Find and fix every problem with kubectl so that all three Deployments are fully Ready and frontend can reach backend through the Service.
2. Do not change container commands, do not remove probes, keep the replica counts, and keep CPU and memory requests on every container (sized sensibly for this node).
3. Write INCIDENT.md in this directory: each root cause you found, the fix, and how you verified it.
