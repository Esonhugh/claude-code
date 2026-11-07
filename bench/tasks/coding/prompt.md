This directory has a small Python inventory module (inventory.py, report.py) with no tests. Do all of the following:
1. Find and fix the bugs: adding an existing SKU should increase quantity; removing more than is in stock or an unknown SKU should raise ValueError; total_value should keep cents (2 decimals); format_report crashes.
2. Add a CLI `cli.py` with subcommands add, remove, report, low-stock (threshold arg) that loads/saves inventory.json in the current directory.
3. Write unittest tests in test_inventory.py covering every fixed bug and every CLI subcommand (run the CLI via subprocess).
4. Run the tests with `python3 -m unittest -v` and make sure they all pass.
5. Finally write NOTES.md listing each bug and its fix in one line each.
