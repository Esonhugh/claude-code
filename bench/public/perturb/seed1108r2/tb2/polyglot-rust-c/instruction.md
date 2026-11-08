Write me a single file in /app/twin/seq.rs which is a polyglot, that is, I can run

`rustc /app/twin/seq.rs && /app/twin/seq N`
or
`g++ -x c++ /app/twin/seq.rs -o /app/twin/cseq && /app/twin/cseq N`.

Both of these should print to stdout the kth term of the sequence g(0) = 1, g(1) = 1, g(n) = g(n-1) + 2*g(n-2), etc.

I'm using rustc 1.75.0 and g++ 13.2.0.
