import json


class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, sku, qty, price):
        if sku in self.items:
            self.items[sku]["qty"] = qty
        else:
            self.items[sku] = {"qty": qty, "price": price}

    def remove(self, sku, qty):
        item = self.items[sku]
        item["qty"] -= qty

    def total_value(self):
        total = 0
        for sku, item in self.items.items():
            total += item["qty"] * item["price"]
        return round(total)

    def save(self, path):
        with open(path, "w") as f:
            json.dump(self.items, f)

    @classmethod
    def load(cls, path):
        inv = cls()
        inv.items = json.load(open(path))
        return inv
