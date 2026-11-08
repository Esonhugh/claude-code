I need one source file, `/app/twin/seq.rs`, that is valid both as Rust and as C++. Both of these must work:

    rustc /app/twin/seq.rs -o /app/twin/seq && /app/twin/seq N
    g++ -x c++ /app/twin/seq.rs -o /app/twin/cseq && /app/twin/cseq N

Each binary prints g(N) on stdout, where g(0) = 1, g(1) = 1 and g(n) = g(n-1) + 2*g(n-2) for n >= 2 (so 1, 1, 3, 5, 11, ...). N is small enough that the result fits in a signed 32-bit integer. `/app/twin/` must contain only `seq.rs` before compiling. Toolchain: rustc 1.75.0, g++ 13.2.0.
