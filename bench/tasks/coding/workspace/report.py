from inventory import Inventory


def low_stock(inv, threshold):
    return [sku for sku, item in inv.items.items() if item["qty"] < threshold]


def format_report(inv):
    lines = []
    for sku in inv.items:
        item = inv.items[sku]
        lines.append(sku + ": " + item["qty"] + " @ " + str(item["price"]))
    return "\n".join(lines)
