import dataclasses, re
@dataclasses.dataclass(frozen=True)
class Policy:
    limit: int
    per_s: float
    burst: int = 0
    def bucket_args(self):
        return dict(rate=self.limit / self.per_s, capacity=self.limit + self.burst)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
def parse_policy(text):
    """Parse '100/m', '5/s+10' (burst), '1000/h'."""
    m = re.fullmatch(r"\s*(\d+)\s*/\s*([smhd])\s*(?:\+\s*(\d+))?\s*", text)
    if not m: raise ValueError(f"bad policy: {text!r}")
    return Policy(int(m.group(1)), float(_UNITS[m.group(2)]), int(m.group(3) or 0))
