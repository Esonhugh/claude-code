Since last night's ssh hardening change, the CI pipeline can no longer deploy to the box at 127.0.0.1 port {PORT}. The pipeline logs in as deploy with keys/deploy_key and runs /opt/app/bin/healthcheck, which must print OK. You have admin access as ops: `ssh -i keys/ops_key -p {PORT} ops@127.0.0.1` (passwordless sudo; the runbook is in ops's home). Work only over ssh; do not use docker or any other way into the box.
1. Find and fix every problem on the box so that `ssh -i keys/deploy_key -p {PORT} deploy@127.0.0.1 /opt/app/bin/healthcheck` prints OK.
2. Keep the hardening intent: only ops and deploy may log in over ssh, StrictModes stays on, password and root logins stay off.
3. Write INCIDENT.md in this directory: each root cause you found, the fix, and how you verified it.
