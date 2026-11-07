You are on call for the "api" service. Users reported /orders being slow and failing around 11:30 UTC on 2026-11-05.
1. Analyse logs/api.log: find when the incident started and ended, the error and warning counts, the p95-ish latency during the incident, and the root cause.
2. Fix config/app.yaml so that `python3 bin/check_config.py` passes (do not edit check_config.py). Use sensible production values.
3. Write bin/rotate_logs.sh: a POSIX shell script that gzips *.log files older than 1 day in a directory given as $1 (default /var/log/api) and deletes .gz files older than keep_days (arg $2, default 7). It must be safe with spaces in filenames and support a --dry-run flag. Make it executable and check it with `sh -n`.
4. Write INCIDENT.md: a short post-mortem (timeline, impact, root cause, fix, follow-ups).
