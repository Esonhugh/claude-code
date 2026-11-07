Write complete developer documentation for the `ratelimit` package in this directory by reading the source:
1. docs/API.md: every public class, method and function with signature, parameters, return value, raised exceptions, and a runnable example for each.
2. docs/GUIDE.md: a conceptual guide comparing token bucket vs sliding window, when to use each, how bursts work in Policy, and pitfalls (clock choice, thread safety - note the code is NOT thread safe).
3. docs/EXAMPLES.md: three end-to-end recipes (per-user API limiting, a background job throttle, parsing policies from config).
4. Verify every example you wrote actually runs by executing them with python3 (put them in examples/*.py and run each).
Do not change the library code.
