import collections, time
class SlidingWindow:
    def __init__(self, limit, window_s, clock=time.monotonic):
        self.limit, self.window_s, self.clock = limit, window_s, clock
        self.hits = collections.deque()
    def hit(self):
        now = self.clock()
        while self.hits and now - self.hits[0] >= self.window_s: self.hits.popleft()
        if len(self.hits) < self.limit:
            self.hits.append(now); return True
        return False
    def remaining(self):
        now = self.clock(); return self.limit - sum(1 for t in self.hits if now - t < self.window_s)
