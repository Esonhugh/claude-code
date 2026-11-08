Please write a single file `/app/pair/twin.py.c` that works both as a Python 3 script and as a C program:

    python3 /app/pair/twin.py.c N
    gcc /app/pair/twin.py.c -o /app/pair/ctwin && /app/pair/ctwin N

Both must print the N-th Lucas number to stdout: L(0) = 2, L(1) = 1, L(n) = L(n-1) + L(n-2). Keep `/app/pair/` containing only `twin.py.c`. Versions: Python 3.12.3, gcc 13.2.0.
