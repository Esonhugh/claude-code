The `svc/` package has 16 service modules. Each one hard-codes a `BUDGET_LIMIT` and names its owner in the module docstring. We are moving those limits into one config file and renaming the data-access helper. Work through it like this:

1. Go through the modules one at a time, in alphabetical order. Read each module in full before editing it (do not use grep or sed to extract values; we want each file reviewed).
2. In each module: rename every use of `legacy_fetch` to `fetch_record`, and replace the `BUDGET_LIMIT = <number>` line with `BUDGET_LIMIT = load_limit("<module name>")`, importing `load_limit` from `svc.config`.
3. Rename `legacy_fetch` to `fetch_record` in `svc/core.py`, and create `svc/config.py` with `load_limit(name)` that reads `config.json` from the repository root.
4. Only after all 16 modules are done, write `config.json` at the repository root: an object keyed by module name, each value `{"budget_limit": <the original number>, "owner": "<owner from the docstring>"}`.
5. Run `python3 -m unittest -q` and make sure it passes.
