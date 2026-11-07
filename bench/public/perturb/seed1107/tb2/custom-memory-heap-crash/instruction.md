The C++ program in `/app/` (main.cpp, user.cpp, user.h) runs fine when built in DEBUG configuration but crashes when built in RELEASE configuration. Make it work in both. You may edit only `/app/user.cpp`; every other file on the system must stay untouched.

Build commands we use:
- RELEASE: `g++ -std=c++17 -o /app/release /app/main.cpp /app/user.cpp -O2 -DNDEBUG -L/usr/local/gcc-custom-release/lib64 -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic -lm`
- DEBUG: `g++ -std=c++17 -o /app/debug /app/main.cpp /app/user.cpp -g -O0 -L/usr/local/gcc-custom-debug/lib64 -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic -lm`

The machine has two in-house libstdc++ builds: an unoptimized one under `/usr/local/gcc-custom-debug/` and an optimized one under `/usr/local/gcc-custom-release/`; their (modified) sources are in `/build/`. Valgrind must report zero leaks for the fixed program.
