Our inventory SQLite file `/srv/recovery/inventory.db` got cut off partway through a copy, so it is no longer a complete database file. Salvage every row you can.

Write the recovered rows to `/srv/recovery/rows.json` as a JSON array of objects with keys `label` (the text column) and `amount` (the numeric column, as a JSON number), for example `[{"label": "kiwiterm17", "amount": 3}, ...]`.
