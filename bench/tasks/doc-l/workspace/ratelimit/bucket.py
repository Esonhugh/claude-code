import time
class TokenBucket:
    def __init__(self, rate, capacity, clock=time.monotonic):
        if rate <= 0 or capacity <= 0:
            raise ValueError("rate and capacity must be positive")
        self.rate, self.capacity, self.clock = rate, capacity, clock
        self.tokens, self.last = capacity, clock()
    def _refill(self):
        now = self.clock(); self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate); self.last = now
    def try_acquire(self, n=1):
        self._refill()
        if n > self.capacity: raise ValueError("n exceeds capacity")
        if self.tokens >= n:
            self.tokens -= n; return True
        return False
    def wait_time(self, n=1):
        self._refill(); return max(0.0, (n - self.tokens) / self.rate)
