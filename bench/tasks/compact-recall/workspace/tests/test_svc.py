import importlib
import unittest

NAMES = ['billing', 'catalog', 'dispatch', 'ledger', 'metering', 'notify', 'orders', 'payouts', 'quota', 'refunds', 'routing', 'search', 'shipping', 'tax', 'users', 'webhooks']


class SvcTest(unittest.TestCase):
    def test_every_module_runs(self):
        for n in NAMES:
            m = importlib.import_module(f"svc.{n}")
            out = getattr(m, f"{n}_step_0")({"k": {"value": 1}}, "k", 1)
            self.assertEqual(out["key"], "k")


if __name__ == "__main__":
    unittest.main()
