"""Shared data access."""


def legacy_fetch(table, key, default=None):
    """Return the row for key from the in-memory table."""
    return table.get(key, default)
