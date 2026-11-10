Build, from scratch in this directory, a small expression language "calc" in Python 3 (standard library only):
1. A package `calc/` with a tokenizer, a recursive-descent parser producing an AST, and an evaluator.
2. Supported: integers and floats, + - * / % and ** (right-assoc), unary minus, parentheses, comparison operators (== != < <= > >=) returning true/false, `let x = expr` bindings, `if cond then a else b`, and built-in functions abs, min, max, sqrt.
3. Clear error messages with the column number for syntax errors, division by zero and unknown names (raise calc.CalcError).
4. A REPL / CLI `python3 -m calc` that evaluates each line of stdin and prints results.
5. At least 30 pytest tests in tests/ covering every feature and every error path.
6. docs/DESIGN.md explaining the grammar (EBNF) and the architecture.
Run `python3 -m pytest -q` and make sure everything passes before you finish.
