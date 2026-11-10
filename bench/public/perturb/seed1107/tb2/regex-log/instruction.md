We grep our access logs for calendar dates written day-first, like 07/11/2026 (DD/MM/YYYY), but only on lines that also mention an IPv4 address.

Produce a single Python regular expression and store it in `/srv/logscan/date_rule.re` (create the directory if needed). We will load it with `open(...).read().strip()` and run `re.findall(pattern, whole_log_text, re.MULTILINE)`.

Rules:
- Only lines containing at least one valid IPv4 address (dotted decimal, each octet 0-255, no leading zeros) count.
- When such a line has several dates, return only the right-most one.
- Day must be valid for its month; treat February as allowing 29 days every year.
- A date or IP that is glued to letters or digits on either side does not count (for example `x07/11/2026`, `10.0.0.1abc`); also watch for look-alike strings such as `user 1134-12-1234`.
- `findall` must return the full date string for each matching line, so use non-capturing groups where needed.
