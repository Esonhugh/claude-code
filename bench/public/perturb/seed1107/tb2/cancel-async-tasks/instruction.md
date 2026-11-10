Write a module `/app/jobgate.py` exposing `async def gated_run(jobs, limit)`, importable as `from jobgate import gated_run`. `jobs` is a list of zero-argument callables that each return an awaitable; `gated_run` must run them with at most `limit` in flight at any moment and return once all are done.

Use the system Python (installing packages is fine). Important: we often stop runs with Ctrl-C. When that happens, every job that has already started must still get to run its own cleanup (e.g. `finally` blocks) before the program exits.
