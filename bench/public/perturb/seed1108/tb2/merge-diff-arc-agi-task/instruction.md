Create `/app/merge-work` and initialise a git repository there.

1. Fetch `/app/bundle1.bundle` (its HEAD) into a local branch `trunk-a`, and `/app/bundle2.bundle` (its HEAD) into a local branch `side-b`. If HEAD is missing or ambiguous in a bundle, inspect its refs and pick the right one, but the branches must still be called `trunk-a` and `side-b`.
2. With `trunk-a` as the base, merge `side-b` into it and resolve every conflict so the tree is consistent.
3. The merged result must contain `/app/merge-work/algo.py` with a function `map(grid)` that takes a 2-D list of ints and returns a 2-D list, implementing the transformation shown by the input/output pairs in `/app/examples.json`. It must generalise: hidden inputs are checked cell by cell.
4. Check that `algo.py` reproduces every example in `/app/examples.json`.
